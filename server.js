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


// Utility function to delete all files in a directory
const clearDirectory = (dirPath) => {
  fs.readdir(dirPath, (err, files) => {
    if (err) throw err;
    for (const file of files) {
      fs.unlink(path.join(dirPath, file), (err) => {
        if (err) throw err;
      });
    }
  });
};

// Clear directories at the start of processing
clearDirectory(imagesDir);
clearDirectory(videosDir);


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


// Process input JSON and handle images and videos
const processMedia = async (mediaList) => {
  const imagePaths = [];
  const videoPaths = [];

  for (const media of mediaList) {
    const ext = path.extname(media).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filePath = ext === '.mp4' ? path.join(videosDir, filename) : path.join(imagesDir, filename);

    await downloadFile(media, filePath);
    if (ext === '.mp4') {
      videoPaths.push(filePath);
    } else {
      imagePaths.push(filePath);
    }
  }

  return { imagePaths, videoPaths };
};



// Modified downloadImage function

async function downloadImage(imageUrl, downloadDir) {
  try {
    const extension = path.extname(imageUrl).split('?')[0]; // Handles URLs with query parameters
    const filename = `${uuidv4()}${extension}`;
    const filePath = path.join(downloadDir, filename);

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://example.com' // Adjust the referer if needed
      },
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Resolve only if status code is 2xx to 3xx
      },
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Error downloading image: ${error.message}`);
    return null; // Return null to indicate a failure
  }
}



module.exports = { downloadImage };

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
    const { videoUrls } = req.body;
    if (!videoUrls || !Array.isArray(videoUrls)) {
      throw new Error('Invalid videoUrls input. It must be an array of video URLs.');
    }

    const downloadedFiles = await Promise.all(
      videoUrls.map(async (videoUrl) => {
        const uniqueFilename = `${uuidv4()}_video.mp4`;
        const outputPath = path.join(videosDir, uniqueFilename);
        await downloadFile(videoUrl, outputPath);
        return outputPath;
      })
    );

    const mergedFileName = `${uuidv4()}_merged.mp4`;
    const outputPath = path.join(storageDir, mergedFileName);
    await mergeVideos(downloadedFiles, outputPath);

    res.status(200).json({ message: 'Videos merged successfully', outputUrl: outputPath });
  } catch (error) {
    console.error('Error merging videos:', error);
    res.status(500).json({ error: 'Failed to merge videos.' });
  }
});

// Endpoint to create a video from multiple images
app.post('/images-to-video', async (req, res) => {
  try {
    const { imageUrls, durationPerImage } = req.body;
    if (!imageUrls || !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'Invalid imageUrls input. It must be an array of image URLs.' });
    }

    // Clear the images directory before downloading new images
    fs.readdir(imagesDir, (err, files) => {
      if (err) throw err;
      for (const file of files) {
        fs.unlink(path.join(imagesDir, file), (err) => {
          if (err) throw err;
        });
      }
    });

    // Set default duration per image (in seconds) if not provided
    const duration = durationPerImage || 2;

    const downloadedFiles = await Promise.all(
      imageUrls.map(async (imageUrl) => {
        const filePath = await downloadImage(imageUrl, imagesDir);
        return filePath; // Include only successfully downloaded files
      })
    );

    // Filter out null values (failed downloads)
    const validFiles = downloadedFiles.filter(file => file !== null);

    if (validFiles.length === 0) {
      return res.status(400).json({ error: 'No valid images were downloaded.' });
    }

    const outputFilePath = path.join(storageDir, `${uuidv4()}_images_to_video.mp4`);
    const command = `ffmpeg -framerate 1/${duration} -pattern_type glob -i '${imagesDir}/*.jpg' -c:v libx264 -r 30 -pix_fmt yuv420p ${outputFilePath}`;
    
    console.log('Executing FFmpeg command for images-to-video:', command);

    await execPromise(command);

    res.status(200).json({ message: 'Video created from images successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error creating video from images:', error);
    res.status(500).json({ error: 'Failed to create video from images.' });
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


// Endpoint to download files
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(storageDir, filename);

  // Check if file exists
  if (fs.existsSync(filePath)) {
    // Set appropriate headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
