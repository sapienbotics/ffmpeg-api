const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const storageDir = '/app/storage/processed';

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

async function downloadFile(url, outputPath) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      response.data.pipe(fs.createWriteStream(outputPath));
      return new Promise((resolve, reject) => {
        response.data.on('end', () => {
          // Check if file size is greater than 0
          fs.stat(outputPath, (err, stats) => {
            if (err) {
              reject(new Error('Failed to retrieve file stats'));
            } else if (stats.size === 0) {
              reject(new Error('Downloaded file is empty'));
            } else {
              resolve();
            }
          });
        });
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading file, retrying...', error);
      retries--;
      if (retries === 0) throw new Error('Failed to download file after retries');
    }
  }
}

function executeFFmpegCommand(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure correct FFmpeg command structure
    const command = `ffmpeg -i ${videoPath} -i ${audioPath} -c:v libx264 -c:a aac -strict experimental -shortest ${outputPath}`;
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

app.post('/edit-video', async (req, res) => {
  try {
    const { inputVideo, inputAudio } = req.body;
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);

    console.log('Downloading video from:', inputVideo);
    await downloadFile(inputVideo, tempVideoPath);

    console.log('Downloading audio from:', inputAudio);
    await downloadFile(inputAudio, tempAudioPath);

    console.log('Processing video with audio...');
    await executeFFmpegCommand(tempVideoPath, tempAudioPath, outputFilePath);

    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp video file:', err);
    });
    fs.unlink(tempAudioPath, (err) => {
      if (err) console.error('Error deleting temp audio file:', err);
    });

    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).json({ error: 'Error processing video' });
  }
});

app.get('/video/:filename', (req, res) => {
  const filePath = path.join(storageDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
