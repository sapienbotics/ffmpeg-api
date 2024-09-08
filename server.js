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

// Function to download the video with retry logic
async function downloadVideo(url, outputPath) {
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
      console.error('Error downloading video, retrying...', error);
      retries--;
      if (retries === 0) throw new Error('Failed to download video after retries');
    }
  }
}

// Function to execute FFmpeg commands
function executeFFmpegCommand(inputPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${inputPath} ${options} ${outputPath}`;
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
    const options = req.body.options || '-c:v copy'; // Default FFmpeg options
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`; // Generate unique filename
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempInputPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`); // Temporary file for input video

    // Step 1: Download the input video
    console.log('Downloading video from:', inputVideoUrl);
    await downloadVideo(inputVideoUrl, tempInputPath);

    // Step 2: Process the video with FFmpeg
    console.log('Processing video...');
    await executeFFmpegCommand(tempInputPath, outputFilePath, options);

    // Step 3: Delete the temporary input video file after processing
    fs.unlink(tempInputPath, (err) => {
      if (err) {
        console.error('Error deleting temp input file:', err);
      } else {
        console.log('Temporary input file deleted:', tempInputPath);
      }
    });

    // Step 4: Respond with the output file path
    res.json({ message: 'Video processed successfully', outputFile: outputFilePath });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Error processing video' });
  }
});

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
