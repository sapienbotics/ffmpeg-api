const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json());

// Utility function to download files from a URL
const downloadFile = (url, outputPath) => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);

    // Use the appropriate module for handling HTTP and HTTPS URLs
    const mod = url.startsWith('https') ? https : http;

    mod.get(url, response => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close(resolve);
        });
      } else {
        reject(new Error(`Failed to download file, status code: ${response.statusCode}`));
      }
    }).on('error', err => {
      fs.unlink(outputPath, () => {}); // Delete the file in case of an error
      reject(err);
    });
  });
};

app.post('/edit-video', async (req, res) => {
  const { inputVideo, inputAudio, outputFile, options } = req.body;

  try {
    // Download the input video and audio files
    const videoPath = '/tmp/temp_input_video.mp4';
    const audioPath = '/tmp/temp_input_audio.mp3';

    await downloadFile(inputVideo, videoPath);
    await downloadFile(inputAudio, audioPath);

    // Build the FFmpeg command
    const command = `ffmpeg -i ${videoPath} -i ${audioPath} ${options} ${outputFile}`;

    // Run FFmpeg command
    exec(command, (error, stdout, stderr) => {
      if (error) {
        return res.status(500).send({ error: error.message });
      }
      if (stderr) {
        return res.status(500).send({ error: stderr });
      }
      res.send({ message: 'Video processed successfully', output: outputFile });
    });

  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.listen(8080, () => {
  console.log('FFmpeg API listening on port 8080');
});
