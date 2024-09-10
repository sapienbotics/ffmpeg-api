const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid'); // For generating unique filenames

const app = express();
app.use(express.json());

const storageDir = '/app/storage/processed'; // Define the directory for processed videos

// Ensure the directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Function to sanitize the URL
function sanitizeUrl(url) {
  return url.replace(/['"]+/g, ''); // Removes single or double quotes
}

// Function to download a file (video/audio)
async function downloadFile(url, outputPath) {
  const sanitizedUrl = sanitizeUrl(url);
  const response = await axios.get(sanitizedUrl, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    response.data.pipe(fs.createWriteStream(outputPath))
      .on('finish', resolve)
      .on('error', reject);
  });
}

// Function to execute FFmpeg commands
function executeFFmpegCommand(inputVideo, inputAudio, outputVideo) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${inputVideo} -i ${inputAudio} -c:v libx264 -c:a aac -strict experimental -shortest ${outputVideo}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', error);
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
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);

    // Step 1: Download the input video
    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    // Step 2: Download the input audio
    console.log('Downloading audio from:', inputAudioUrl);
    await downloadFile(inputAudioUrl, tempAudioPath);

    // Step 3: Process the video with FFmpeg
    console.log('Processing video...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath);

    // Step 4: Delete the temporary input video and audio files after processing
    fs.unlink(tempVideoPath, (err) => {
      if (err) {
        console.error('Error deleting temp video file:', err);
      } else {
        console.log('Temporary video file deleted:', tempVideoPath);
      }
    });
    fs.unlink(tempAudioPath, (err) => {
      if (err) {
        console.error('Error deleting temp audio file:', err);
      } else {
        console.log('Temporary audio file deleted:', tempAudioPath);
      }
    });

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
