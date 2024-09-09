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

// Ensure directories exist
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Function to download files with retry logic and logging
async function downloadFile(url, outputPath) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await axios.get(url, { responseType: 'stream', timeout: 60000 }); // 60s timeout
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (error) {
      console.error(`Error downloading file from ${url}. Retries left: ${retries - 1}`, error.message);
      retries--;
      if (retries === 0) throw new Error(`Failed to download file from ${url} after retries`);
    }
  }
}

// Function to verify file validity after download
const verifyFile = (filePath) => {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) {
        reject(new Error(`File not found: ${filePath}`));
      } else if (stats.size === 0) {
        reject(new Error(`File is empty: ${filePath}`));
      } else {
        resolve();
      }
    });
  });
};

// Execute FFmpeg command with detailed logging
function executeFFmpegCommand(videoPath, audioPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `ffmpeg -i ${videoPath} -i ${audioPath} ${options} ${outputPath}`;
    console.log(`Executing FFmpeg command: ${command}`);

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(new Error(`FFmpeg failed: ${stderr}`));
      } else {
        console.log('FFmpeg output:', stdout);
        resolve();
      }
    });
  });
}

// Clean up old processed files
function cleanUpOldFiles() {
  console.log('Cleaning up old processed files...');
  const files = fs.readdirSync(storageDir);
  files.forEach(file => {
    if (file.endsWith('_processed_video.mp4')) {
      try {
        fs.unlinkSync(path.join(storageDir, file));
        console.log(`Deleted old file: ${file}`);
      } catch (err) {
        console.error('Error deleting old file:', file, err.message);
      }
    }
  });
}

// Main API for editing video
app.post('/edit-video', async (req, res) => {
  try {
    const { inputVideo, inputAudio, options = '-c:v copy -c:a aac -strict experimental -shortest' } = req.body;

    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(tempDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(tempDir, `${uuidv4()}_temp_audio.mp3`);

    // Step 1: Clean up old files
    cleanUpOldFiles();

    // Step 2: Download the input video
    console.log('Downloading video from:', inputVideo);
    await downloadFile(inputVideo, tempVideoPath);

    // Step 3: Download the input audio
    console.log('Downloading audio from:', inputAudio);
    await downloadFile(inputAudio, tempAudioPath);

    // Step 4: Verify downloaded files
    console.log('Verifying downloaded files...');
    await verifyFile(tempVideoPath);
    await verifyFile(tempAudioPath);

    // Step 5: Process video using FFmpeg
    console.log('Processing video with FFmpeg...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath, options);

    // Step 6: Respond with the output file path
    console.log('Video processed successfully:', uniqueFilename);
    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ error: 'Error processing video' });
  } finally {
    // Clean up temporary files
    if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
    if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
  }
});

// Serve processed video files
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(storageDir, req.params.filename);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
