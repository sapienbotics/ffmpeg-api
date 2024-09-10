const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const storageDir = '/app/storage/processed';
const tempDir = '/app/storage/temp';

// Ensure the directories exist
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Function to download files
async function downloadFile(url, outputPath) {
  try {
    const response = await axios.get(url, { responseType: 'stream' });
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    throw error;
  }
}

// Function to verify if a file is valid
async function verifyFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err || stats.size === 0) {
        reject(new Error('File is empty or does not exist'));
      } else {
        resolve();
      }
    });
  });
}

// Function to execute FFmpeg commands
function executeFFmpegCommand(videoPath, audioPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${videoPath} -i ${audioPath} ${options} ${outputPath}`;
    console.log('Executing FFmpeg command:', command);
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output:', stdout);
        resolve();
      }
    });
  });
}

// Main API to handle video editing
app.post('/edit-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const { inputVideo, inputAudio, options = '-c:v libx264 -c:a aac -strict experimental -shortest' } = req.body;

    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(tempDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(tempDir, `${uuidv4()}_temp_audio.mp3`);

    // Clean up old files
    console.log('Cleaning up old processed files...');
    fs.readdirSync(storageDir).forEach(file => {
      if (file.endsWith('_processed_video.mp4')) {
        fs.unlinkSync(path.join(storageDir, file));
        console.log(`Deleted old file: ${file}`);
      }
    });

    // Download input files
    console.log('Downloading video from:', inputVideo);
    await downloadFile(inputVideo, tempVideoPath);

    console.log('Downloading audio from:', inputAudio);
    await downloadFile(inputAudio, tempAudioPath);

    // Verify the files
    console.log('Verifying downloaded files...');
    await verifyFile(tempVideoPath);
    await verifyFile(tempAudioPath);

    // Process the video with FFmpeg
    console.log('Processing video with FFmpeg...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath, options);

    // Respond with the output file path
    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Error processing video' });
  }
});

// Serve the processed video files
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(storageDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
