const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');

const app = express();
app.use(express.json());

// Set storage directory for Railway environment
const storageDir = '/app/storage/processed';

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

// Ensure storage directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir);
}

// Function to download a file
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

// Normalize video format
const normalizeVideo = async (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${inputPath} -vf "scale=1280:720" -r 30 -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k ${outputPath} -y`;
    console.log('Executing FFmpeg command for normalization:', command);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Normalization error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
};

// Trim video
const trimVideo = async (inputPath, outputPath, startTime, duration) => {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${inputPath} -ss ${startTime} -t ${duration} -c copy ${outputPath} -y`;
    console.log('Executing FFmpeg command for trimming:', command);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Trimming error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
};

// Resize video
const resizeVideo = async (inputPath, outputPath, width, height) => {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${inputPath} -vf scale=${width}:${height} -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k ${outputPath} -y`;
    console.log('Executing FFmpeg command for resizing:', command);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Resizing error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
};

// Merge videos
const mergeVideos = async (inputPaths, outputPath) => {
  try {
    const listFilePath = path.join(storageDir, 'file_list.txt');
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);

    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy -y ${outputPath} -progress ${path.join(storageDir, 'ffmpeg_progress.log')} -loglevel verbose`;
    console.log('Executing FFmpeg command for merging:', command);

    await execPromise(command, 600000); // 10 minutes timeout

    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    throw new Error('Error merging videos: ' + error.message);
  }
};

// Execute shell command and handle timeout
const execPromise = (command, timeout) => {
  return new Promise((resolve, reject) => {
    const child = exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });

    // Set a timeout for the command
    setTimeout(() => {
      child.kill('SIGTERM'); // Terminate the process if it exceeds the timeout
      reject(new Error('FFmpeg process timed out'));
    }, timeout);
  });
};

// Endpoint to trim video
app.post('/trim-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);

    const inputVideoUrl = req.body.inputVideoUrl;
    const startTime = req.body.startTime;
    const duration = req.body.duration;
    const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    if (!inputVideoUrl || !startTime || !duration) {
      throw new Error('Missing input video URL, start time, or duration in request body');
    }

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    console.log('Trimming video...');
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    console.log('Cleaning up temporary files...');
    fs.unlinkSync(tempVideoPath);

    res.status(200).json({ message: 'Video trimmed successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error trimming video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to resize video
app.post('/resize-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);

    const inputVideoUrl = req.body.inputVideoUrl;
    const width = req.body.width;
    const height = req.body.height;
    const uniqueFilename = `${uuidv4()}_resized_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    if (!inputVideoUrl || !width || !height) {
      throw new Error('Missing input video URL, width, or height in request body');
    }

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    console.log('Resizing video...');
    await resizeVideo(tempVideoPath, outputFilePath, width, height);

    console.log('Cleaning up temporary files...');
    fs.unlinkSync(tempVideoPath);

    res.status(200).json({ message: 'Video resized successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error resizing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to merge videos
app.post('/merge-videos', async (req, res) => {
  let validVideos = []; // Define validVideos here

  try {
    const { videos } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty video URLs array.' });
    }

    console.log('Request received:', req.body);

    // Clean and validate video URLs
    validVideos = videos.filter(url => typeof url === 'string' && url.trim() !== '');
    if (validVideos.length === 0) {
      return res.status(400).json({ error: 'No valid video URLs provided.' });
    }

    console.log('Valid Video URLs:', validVideos);

    // Download and normalize the videos
    const downloadPromises = validVideos.map(async (url, index) => {
      const originalFilePath = path.join(storageDir, `video${index + 1}.mp4`);
      const normalizedFilePath = path.join(storageDir, `video${index + 1}_normalized.mp4`);
      
      console.log(`Downloading file from URL: ${url}`);
      await downloadFile(url, originalFilePath);
      
      console.log(`Normalizing video: ${originalFilePath}`);
      await normalizeVideo(originalFilePath, normalizedFilePath);
      
      fs.unlinkSync(originalFilePath); // Clean up the original file
      return normalizedFilePath;
    });

    const normalizedFiles = await Promise.all(downloadPromises);

    // Merge the normalized videos
    const outputFilePath = path.join(storageDir, 'merged_output.mp4');
    await mergeVideos(normalizedFiles, outputFilePath);

    console.log('Video merge completed:', outputFilePath);
    res.json({ message: 'Videos merged successfully!', mergedVideo: outputFilePath });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    // Cleanup temporary files
    if (validVideos.length > 0) {
      validVideos.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
    }
  }
});

// Endpoint to edit video
app.post('/edit-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);

    const { inputVideoUrl, startTime, duration, width, height } = req.body;
    const uniqueFilename = `${uuidv4()}_edited_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    if (!inputVideoUrl || !startTime || !duration || !width || !height) {
      throw new Error('Missing required parameters in request body');
    }

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    console.log('Trimming and resizing video...');
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);
    await resizeVideo(outputFilePath, outputFilePath, width, height);

    console.log('Cleaning up temporary files...');
    fs.unlinkSync(tempVideoPath);

    res.status(200).json({ message: 'Video edited successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error editing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
