const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const storageDir = '/app/storage/processed';

// Ensure the directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Function to download files with retry logic
async function downloadFile(url, outputPath) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      response.data.pipe(fs.createWriteStream(outputPath));
      return new Promise((resolve, reject) => {
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading file, retrying...', error);
      retries--;
      if (retries === 0) throw new Error('Failed to download file after retries');
    }
  }
}

// Function to verify if a file is valid
const verifyFile = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) {
        reject(err);
      } else if (stats.size === 0) {
        reject(new Error('File is empty'));
      } else {
        resolve();
      }
    });
  });
};

// Function to execute FFmpeg commands
function executeFFmpegCommand(videoPath, audioPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${videoPath} -i ${audioPath} ${options} ${outputPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr); // Log stderr for more details
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
    const inputVideoUrl = req.body.inputVideo;
    const inputAudioUrl = req.body.inputAudio;
    const options = req.body.options || '-c:v copy -c:a aac -strict experimental -shortest'; // Default FFmpeg options
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);

    // Step 1: Clean up old files
    console.log('Cleaning up old files...');
    try {
      fs.readdirSync(storageDir).forEach(file => {
        if (file.endsWith('_processed_video.mp4')) {
          fs.unlinkSync(path.join(storageDir, file));
          console.log(`Deleted old file: ${file}`);
        }
      });
    } catch (err) {
      console.error('Error cleaning up old files:', err);
    }

    // Step 2: Download the input video
    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    // Step 3: Download the input audio
    console.log('Downloading audio from:', inputAudioUrl);
    await downloadFile(inputAudioUrl, tempAudioPath);

    // Verify downloaded files
    console.log('Verifying downloaded files...');
    await verifyFile(tempVideoPath);
    await verifyFile(tempAudioPath);

    // Step 4: Process the video with FFmpeg
    console.log('Processing video...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath, options);

    // Step 5: Respond with the output file path
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
