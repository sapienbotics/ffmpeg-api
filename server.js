const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');

const app = express();
app.use(express.json());

// Set storage directory
const storageDir = '/app/storage/processed';
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

// Download video file
const downloadFile = async (url, filePath) => {
  try {
    // Log the URL and file path
    console.log('Downloading file from URL:', url);
    console.log('Saving to path:', filePath);

    // Ensure the directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (error) {
      throw new Error(`Invalid URL format: ${url}`);
    }

    // Download the file
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
    });

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error('File download failed');
  }
};



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
  if (Edits.scale) {
    filters += `${filters ? ',' : ''}scale=${edits.scale}`;
  }

  const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Function to add audio to video
const addAudioToVideo = async (videoUrl, contentAudioUrl, backgroundAudioUrl, outputPath) => {
  try {
    // Define paths for temporary files
    const videoPath = path.resolve(`/app/storage/processed/${uuidv4()}_video.mp4`);
    const contentAudioPath = path.resolve(`/app/storage/processed/${uuidv4()}_content_audio.mp3`);
    const backgroundAudioPath = path.resolve(`/app/storage/processed/${uuidv4()}_background_audio.mp3`);

    // Log paths
    console.log('Paths:', {
      videoPath,
      contentAudioPath,
      backgroundAudioPath,
      outputPath
    });

    // Download video and audio files if URLs are provided
    if (videoUrl.startsWith('http')) {
      await downloadFile(videoUrl, videoPath);
    } else {
      // If local file path, just use it
      fs.copyFileSync(videoUrl, videoPath);
    }

    if (contentAudioUrl.startsWith('http')) {
      await downloadFile(contentAudioUrl, contentAudioPath);
    } else {
      // If local file path, just use it
      fs.copyFileSync(contentAudioUrl, contentAudioPath);
    }

    if (backgroundAudioUrl.startsWith('http')) {
      await downloadFile(backgroundAudioUrl, backgroundAudioPath);
    } else {
      // If local file path, just use it
      fs.copyFileSync(backgroundAudioUrl, backgroundAudioPath);
    }

    // Command to add audio to video using FFmpeg
    const command = `ffmpeg -i ${videoPath} -i ${contentAudioPath} -i ${backgroundAudioPath} -filter_complex "[0:a]volume=1[a]; [1:a]volume=1[b]; [2:a]volume=0.5[c]; [a][b][c]amerge=inputs=3[aout]" -map "[aout]" ${outputPath}`;

    console.log('Running command:', command);

    // Execute the FFmpeg command
    await execPromise(command);

    console.log('Audio added to video successfully:', outputPath);
  } catch (error) {
    console.error('Error in adding audio to video:', error);
    throw new Error('Audio-Video merge failed');
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
    const tempVideoPath = path.join('/app/storage/processed', `${uuidv4()}_temp_video.mp4`);
    const outputFilePath = path.join('/app/storage/processed', `${uuidv4()}_trimmed_video.mp4`);

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
    await resizeVideo(tempVideoPath, outputFilePath, width, height);

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

      fs.unlinkSync(originalFilePath);
      return normalizedFilePath;
    });

    const normalizedFiles = await Promise.all(downloadPromises);
    const outputFilePath = path.join(storageDir, 'merged_output.mp4');
    await mergeVideos(normalizedFiles, outputFilePath);

    res.json({ message: 'Videos merged successfully!', mergedVideo: outputFilePath });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    validVideos.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
  }
});

// Endpoint to edit video
app.post('/edit-video', async (req, res) => {
  try {
    const { inputVideoUrl, edits } = req.body;
    if (!inputVideoUrl || !edits) {
      throw new Error('Missing input video URL or edits in request body');
    }

    const uniqueFilename = `${uuidv4()}_edited_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    await downloadFile(inputVideoUrl, tempVideoPath);
    await editVideo(tempVideoPath, outputFilePath, edits);

    fs.unlinkSync(tempVideoPath);
    res.status(200).json({ message: 'Video edited successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error editing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// Endpoint to add audio to video
app.post('/add-audio', async (req, res) => {
  try {
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume, backgroundVolume } = req.body;

    // Validate inputs
    if (!videoUrl || !contentAudioUrl || !backgroundAudioUrl) {
      return res.status(400).json({ error: 'Missing video URL, content audio URL, or background audio URL.' });
    }

    // Define paths for video, content audio, background audio, and output
    const videoPath = path.join(storageDir, `${uuidv4()}_input_video.mp4`);
    const contentAudioPath = path.join(storageDir, `${uuidv4()}_content_audio.mp3`);
    const backgroundAudioPath = path.join(storageDir, `${uuidv4()}_background_audio.mp3`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_final_output.mp4`);

    // Download the video and both audio files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(contentAudioUrl, contentAudioPath);
    await downloadFile(backgroundAudioUrl, backgroundAudioPath);

    // Call function to add audio to video
    await addAudioToVideo(videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume, backgroundVolume);

    // Clean up the temp files if necessary (optional)
    fs.unlinkSync(videoPath);
    fs.unlinkSync(contentAudioPath);
    fs.unlinkSync(backgroundAudioPath);

    // Return the path to the final video
    res.status(200).json({ message: 'Audio added successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing add-audio request:', error.message);
    res.status(500).json({ error: 'An error occurred while adding audio to the video.' });
  }
});


// Endpoint to download file
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(storageDir, filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Endpoint to get status
app.get('/status', (req, res) => {
  res.json({ status: 'API is running', timestamp: new Date().toISOString() });
});

// Start server
app.listen(8080, () => {
  console.log('Server is running on port 8080');
});
