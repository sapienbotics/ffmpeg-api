const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');

const app = express();
app.use(express.json());

// Set storage directory
const storageDir = '/app/storage/processed';
const imagesDir = path.join(__dirname, 'images');
const videosDir = path.join(__dirname, 'videos');

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

// Download video file
const downloadFile = async (url, filepath) => {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

async function downloadImage(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};  // <- Optional semicolon here

// Normalize video format
const normalizeVideo = async (inputPath, outputPath) => {
  const command = `ffmpeg -i ${inputPath} -vf "scale=1280:720" -r 30 -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k ${outputPath} -y`;
  console.log('Executing FFmpeg command for normalization:', command);

  await execPromise(command);
};

// Merge videos
const mergeVideos = async (inputPaths, outputPath) => {
  const listFilePath = path.join(storageDir, 'file_list.txt');
  const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(listFilePath, fileListContent);

  const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy -y ${outputPath} -progress ${path.join(storageDir, 'ffmpeg_progress.log')} -loglevel verbose`;
  console.log('Executing FFmpeg command for merging:', command);

  await execPromise(command, 600000); // 10 minutes timeout

  fs.unlinkSync(listFilePath); // Clean up the list file
};

// Function to resize video using FFmpeg
const resizeVideo = async (inputPath, outputPath, width, height) => {
  const command = `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Function to apply edits to video (e.g., cropping) using FFmpeg
const editVideo = async (inputPath, outputPath, edits) => {
  let filters = '';
  if (edits.crop) {
    filters += `crop=${edits.crop}`;
  }
  if (edits.scale) {
    filters += `${filters ? ',' : ''}scale=${edits.scale}`;
  }

  const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Function to add audio to video
const addAudioToVideo = async (videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume, backgroundVolume) => {
  try {
    // Validate volume inputs
    const contentVol = contentVolume ? contentVolume : 1.0; // Default volume for content audio
    const backgroundVol = backgroundVolume ? backgroundVolume : 1.0; // Default volume for background audio

    // FFmpeg command to add both content audio and background audio
    const command = `
      ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex \
      "[1:a]volume=${contentVol}[a1];[2:a]volume=${backgroundVol}[a2];[a1][a2]amix=inputs=2:duration=longest" \
      -c:v copy -shortest -y "${outputFilePath}"
    `;

    // Execute FFmpeg command
    await execPromise(command);
    console.log('Audio added successfully');
  } catch (error) {
    console.error('Error adding audio to video:', error);
    throw error;
  }
};

// Trim video function
async function trimVideo(inputPath, outputPath, startTime, duration) {
  try {
    // Ensure startTime and duration are valid
    if (!startTime || !duration) {
      throw new Error('Invalid startTime or duration');
    }

    // Construct ffmpeg command for trimming
    const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -c:v libx264 -c:a aac "${outputPath}"`;

    // Log the command for debugging purposes
    console.log(`Executing command: ${command}`);

    // Execute the ffmpeg command
    await execPromise(command);
  } catch (error) {
    console.error('Error trimming video:', error);
    throw error;
  }
}

// Endpoint to trim the video
app.post('/trim-video', async (req, res) => {
  try {
    // Extract input parameters from request body
    const { inputVideoUrl, startTime, duration } = req.body;

    // Validate request parameters
    if (!inputVideoUrl || startTime === undefined || duration === undefined) {
      return res.status(400).json({ error: 'Missing or invalid inputVideoUrl, startTime, or duration' });
    }

    // Log the received values for debugging
    console.log(`Received inputVideoUrl: ${inputVideoUrl}, startTime: ${startTime}, duration: ${duration}`);

    // Define paths for temp and output video files
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_trimmed_video.mp4`);

    // Download the input video to the temp path (assuming downloadFile is defined)
    await downloadFile(inputVideoUrl, tempVideoPath);

    // Call trimVideo to perform the trimming operation
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    // Respond with the path to the trimmed video
    res.json({ trimmedVideoUrl: outputFilePath });

  } catch (error) {
    console.error('Error processing trim-video request:', error);
    res.status(500).json({ error: 'An error occurred while trimming the video.' });
  }
});

// Endpoint to resize video
app.post('/resize-video', async (req, res) => {
  try {
    const { inputVideoUrl, width, height } = req.body;
    if (!inputVideoUrl || !width || !height) {
      throw new Error('Missing input video URL, width, or height in request body');
    }

    const uniqueFilename = `${uuidv4()}_resized_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    await downloadFile(inputVideoUrl, tempVideoPath);
    await resizeVideo(tempVideoPath, outputFilePath);

    fs.unlinkSync(tempVideoPath);
    res.status(200).json({ message: 'Video resized successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error resizing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to merge videos
app.post('/merge-videos', async (req, res) => {
  try {
    const { videos } = req.body;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty video URLs array.' });
    }

    const validVideos = videos.filter(url => typeof url === 'string' && url.trim() !== '');
    if (validVideos.length === 0) {
      return res.status(400).json({ error: 'No valid video URLs provided.' });
    }

    const downloadPromises = validVideos.map(async (url, index) => {
      const originalFilePath = path.join(storageDir, `video${index + 1}.mp4`);
      const normalizedFilePath = path.join(storageDir, `video${index + 1}_normalized.mp4`);

      await downloadFile(url, originalFilePath);
      await normalizeVideo(originalFilePath, normalizedFilePath);
      fs.unlinkSync(originalFilePath); // Clean up the original file

      return normalizedFilePath;
    });

    const downloadedVideos = await Promise.all(downloadPromises);
    const mergedVideoPath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);

    await mergeVideos(downloadedVideos, mergedVideoPath);

    res.status(200).json({ message: 'Videos merged successfully', outputUrl: mergedVideoPath });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to add audio to video
app.post('/add-audio-to-video', async (req, res) => {
  try {
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume, backgroundVolume } = req.body;

    if (!videoUrl || !contentAudioUrl || !backgroundAudioUrl) {
      return res.status(400).json({ error: 'Missing video URL or audio URLs.' });
    }

    const videoFilePath = path.join(storageDir, 'input_video.mp4');
    const contentAudioFilePath = path.join(storageDir, 'content_audio.mp3');
    const backgroundAudioFilePath = path.join(storageDir, 'background_audio.mp3');
    const outputFilePath = path.join(storageDir, 'output_video.mp4');

    await downloadFile(videoUrl, videoFilePath);
    await downloadFile(contentAudioUrl, contentAudioFilePath);
    await downloadFile(backgroundAudioUrl, backgroundAudioFilePath);

    await addAudioToVideo(videoFilePath, contentAudioFilePath, backgroundAudioFilePath, outputFilePath, contentVolume, backgroundVolume);

    fs.unlinkSync(videoFilePath);
    fs.unlinkSync(contentAudioFilePath);
    fs.unlinkSync(backgroundAudioFilePath);

    res.status(200).json({ message: 'Audio added to video successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error adding audio to video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to convert images to video
app.post('/images-to-video', async (req, res) => {
  try {
    const { imageUrls } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty image URLs array.' });
    }

    const validImageUrls = imageUrls.filter(url => typeof url === 'string' && url.trim() !== '');
    if (validImageUrls.length === 0) {
      return res.status(400).json({ error: 'No valid image URLs provided.' });
    }

    // Download images
    const downloadPromises = validImageUrls.map(async (url, index) => {
      const imagePath = path.join(imagesDir, `image${index + 1}.jpg`);
      await downloadImage(url, imagePath);
      return imagePath;
    });
    const downloadedImages = await Promise.all(downloadPromises);

    // Create a video from images
    const videoFilePath = path.join(storageDir, `${uuidv4()}_images_video.mp4`);
    const imagesListFilePath = path.join(imagesDir, 'images_list.txt');
    const imagesListContent = downloadedImages.map(img => `file '${img}'`).join('\n');
    fs.writeFileSync(imagesListFilePath, imagesListContent);

    const command = `ffmpeg -f concat -safe 0 -i ${imagesListFilePath} -vf "fps=1,format=yuv420p" ${videoFilePath}`;
    console.log('Executing FFmpeg command for images-to-video:', command);

    await execPromise(command);

    fs.unlinkSync(imagesListFilePath); // Clean up the list file
    downloadedImages.forEach(image => fs.unlinkSync(image)); // Clean up downloaded images

    res.status(200).json({ message: 'Images converted to video successfully', outputUrl: videoFilePath });
  } catch (error) {
    console.error('Error converting images to video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
