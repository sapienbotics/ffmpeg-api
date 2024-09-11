const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffprobe = require('ffprobe-static');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

const storageDir = process.env.STORAGE_DIR || '/app/storage/processed';

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
      console.error('Error downloading file, retrying...', error.message);
      retries--;
      if (retries === 0) throw new Error('Failed to download file after retries');
    }
  }
}

// Function to log file properties using ffprobe
function logFileProperties(filePath) {
  try {
    const output = execSync(`${ffprobe.path} -v error -show_format -show_streams ${filePath}`).toString();
    console.log(`File properties for ${filePath}:\n`, output);
  } catch (error) {
    console.error(`Error logging properties for ${filePath}:`, error.message);
  }
}

// Function to preprocess audio with FFmpeg
function preprocessAudio(inputAudioPath, outputAudioPath, volume) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputAudioPath} -ar 44100 -ac 2 -af "volume=${volume}" ${outputAudioPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during audio preprocessing:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during audio preprocessing:', stdout);
        resolve();
      }
    });
  });
}

// Function to preprocess background audio with FFmpeg
function preprocessBackgroundAudio(inputAudioPath, outputAudioPath, volume) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputAudioPath} -ar 44100 -ac 2 -af "volume=${volume}" ${outputAudioPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during background audio preprocessing:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during background audio preprocessing:', stdout);
        resolve();
      }
    });
  });
}

// Function to execute FFmpeg commands for merging video and audio
function executeFFmpegCommand(inputVideoPath, inputAudioPath, backgroundAudioPath, outputPath) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -i ${inputAudioPath} -i ${backgroundAudioPath} -filter_complex "[0:v] [1:a] [2:a] amerge=inputs=2 [a]" -map 0:v -map "[a]" -c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest ${outputPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during merging:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during merging:', stdout);
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
    const backgroundAudioUrl = req.body.backgroundAudio;
    const inputAudioVolume = req.body.inputAudioVolume || '1'; // Default volume is 1
    const backgroundAudioVolume = req.body.backgroundAudioVolume || '0.5'; // Default volume is 0.5
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`; // Generate unique filename
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`); // Temporary file for input video
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`); // Temporary file for input audio
    const backgroundAudioPath = path.join(storageDir, `${uuidv4()}_background_audio.mp3`); // Temporary file for background audio
    const processedAudioPath = path.join(storageDir, `${uuidv4()}_processed_audio.mp4`); // Processed audio file
    const processedBackgroundAudioPath = path.join(storageDir, `${uuidv4()}_processed_background_audio.mp4`); // Processed background audio file

    // Step 1: Download the input video and audio
    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);
    console.log('Downloading audio from:', inputAudioUrl);
    await downloadFile(inputAudioUrl, tempAudioPath);
    console.log('Downloading background audio from:', backgroundAudioUrl);
    await downloadFile(backgroundAudioUrl, backgroundAudioPath);

    // Log file properties
    logFileProperties(tempVideoPath);
    logFileProperties(tempAudioPath);
    logFileProperties(backgroundAudioPath);

    // Step 2: Preprocess the audio
    console.log('Preprocessing input audio...');
    await preprocessAudio(tempAudioPath, processedAudioPath, inputAudioVolume);
    
    // Step 2: Preprocess the background audio
    console.log('Preprocessing background audio...');
    await preprocessBackgroundAudio(backgroundAudioPath, processedBackgroundAudioPath, backgroundAudioVolume);

    // Step 3: Process the video with FFmpeg
    console.log('Processing video with audio...');
    await executeFFmpegCommand(tempVideoPath, processedAudioPath, processedBackgroundAudioPath, outputFilePath);

    // Step 4: Delete the temporary files after processing
    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp video file:', err.message);
    });
    fs.unlink(tempAudioPath, (err) => {
      if (err) console.error('Error deleting temp audio file:', err.message);
    });
    fs.unlink(backgroundAudioPath, (err) => {
      if (err) console.error('Error deleting background audio file:', err.message);
    });
    fs.unlink(processedAudioPath, (err) => {
      if (err) console.error('Error deleting processed audio file:', err.message);
    });
    fs.unlink(processedBackgroundAudioPath, (err) => {
      if (err) console.error('Error deleting processed background audio file:', err.message);
    });

    // Step 5: Respond with the output file path
    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error.message);
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

// Graceful shutdown handling
const server = app.listen(process.env.PORT || 8080, () => {
  console.log(`Server running on port ${process.env.PORT || 8080}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received.');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received.');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
});
