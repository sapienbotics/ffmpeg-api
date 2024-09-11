const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

const storageDir = process.env.STORAGE_DIR || '/app/storage/processed';

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

async function downloadFile(url, outputPath) {
  const response = await axios.get(url, { responseType: 'stream' });
  response.data.pipe(fs.createWriteStream(outputPath));
  return new Promise((resolve, reject) => {
    response.data.on('end', resolve);
    response.data.on('error', reject);
  });
}

function executeFFmpegCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg stdout:', stdout);
        resolve(stdout);
      }
    });
  });
}

app.post('/edit-video', async (req, res) => {
  try {
    const { inputVideo, inputAudio, backgroundAudio, inputAudioVolume, backgroundAudioVolume, outputFile, options } = req.body;

    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);
    const tempBackgroundAudioPath = path.join(storageDir, `${uuidv4()}_temp_background_audio.mp3`);

    // Download files
    console.log('Downloading input video...');
    await downloadFile(inputVideo, tempVideoPath);
    console.log('Downloading input audio...');
    await downloadFile(inputAudio, tempAudioPath);
    console.log('Downloading background audio...');
    await downloadFile(backgroundAudio, tempBackgroundAudioPath);

    // Log file properties (optional)
    // logFileProperties(tempVideoPath); 

    // FFmpeg command to merge video, audio, and background audio
    const ffmpegCommand = `
      ${ffmpegPath} -i ${tempVideoPath} -i ${tempAudioPath} -i ${tempBackgroundAudioPath} \
      -filter_complex "[1:a]volume=${inputAudioVolume}[a1];[2:a]volume=${backgroundAudioVolume}[a2];[a1][a2]amerge=inputs=2,pan=stereo|c0<c0+c2|c1<c1+c3[a]" \
      -map 0:v -map "[a]" ${options} ${outputFilePath}
    `;

    console.log('Running FFmpeg command...');
    console.log(ffmpegCommand);

    await executeFFmpegCommand(ffmpegCommand);

    // Clean up temporary files
    fs.unlink(tempVideoPath, err => { if (err) console.error('Error deleting temp video file:', err.message); });
    fs.unlink(tempAudioPath, err => { if (err) console.error('Error deleting temp audio file:', err.message); });
    fs.unlink(tempBackgroundAudioPath, err => { if (err) console.error('Error deleting temp background audio file:', err.message); });

    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });

  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ error: 'Error processing video' });
  }
});

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
