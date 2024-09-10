const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffprobe = require('ffprobe-static');
const ffmpegPath = require('ffmpeg-static');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

const storageDir = '/app/storage/processed'; // Define the directory for processed videos

// Ensure the directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Function to download the file with retry logic
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

// Function to log file properties
function logFileProperties(filePath) {
  try {
    const output = execSync(`${ffprobe.path} -v error -show_format -show_streams ${filePath}`).toString();
    console.log(`File properties for ${filePath}:\n`, output);
  } catch (error) {
    console.error(`Error logging properties for ${filePath}:`, error);
  }
}

// Function to execute FFmpeg commands
function executeFFmpegCommand(inputVideoPath, inputAudioPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -i ${inputAudioPath} ${options} ${outputPath}`;
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
    const options = req.body.options || '-c:v libx264 -c:a aac -strict experimental -shortest'; // Default FFmpeg options
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`; // Generate unique filename
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`); // Temporary file for input video
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`); // Temporary file for input audio

    // Step 1: Download the input video and audio
    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);
    console.log('Downloading audio from:', inputAudioUrl);
    await downloadFile(inputAudioUrl, tempAudioPath);

    // Log file properties
    logFileProperties(tempVideoPath);
    logFileProperties(tempAudioPath);

    // Step 2: Process the video with FFmpeg
    console.log('Processing video with audio...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath, options);

    // Step 3: Delete the temporary files after processing
    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp video file:', err);
    });
    fs.unlink(tempAudioPath, (err) => {
      if (err) console.error('Error deleting temp audio file:', err);
    });

    // Step 4: Respond with the output file path
    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Error processing video' });
  }
});

// Serve the processed video files
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(storageDir, req.params.filename);
  
  // Check if the file exists
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
