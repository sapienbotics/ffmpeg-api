const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());

app.post('/edit-video', async (req, res) => {
  const { inputVideo, inputAudio, outputFile, options } = req.body;

  // Validate input
  if (!inputVideo || !inputAudio || !outputFile) {
    return res.status(400).send({ error: 'Missing required fields' });
  }

  // Temporary local paths for input and output files
  const tempInputVideo = path.join(__dirname, 'temp_input_video.mp4');
  const tempInputAudio = path.join(__dirname, 'temp_input_audio.mp3');
  const tempOutputFile = path.join(__dirname, outputFile);

  try {
    // Download files from URLs
    await downloadFile(inputVideo, tempInputVideo);
    await downloadFile(inputAudio, tempInputAudio);

    // Build the FFmpeg command
    const command = `ffmpeg -i ${tempInputVideo} -i ${tempInputAudio} ${options} ${tempOutputFile}`;

    console.log('Running command:', command);

    // Run FFmpeg command
    exec(command, (error, stdout, stderr) => {
      // Clean up temporary files
      fs.unlink(tempInputVideo, () => {});
      fs.unlink(tempInputAudio, () => {});

      if (error) {
        return res.status(500).send({ error: error.message });
      }
      if (stderr) {
        return res.status(500).send({ error: stderr });
      }

      res.send({ message: 'Video processed successfully', output: stdout });
    });

  } catch (downloadError) {
    // Clean up in case of download errors
    fs.unlink(tempInputVideo, () => {});
    fs.unlink(tempInputAudio, () => {});
    res.status(500).send({ error: `Failed to download files: ${downloadError.message}` });
  }
});

// Function to download files from URLs
const downloadFile = (url, outputPath) => {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    const request = require('https').get(url, response => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', err => {
      fs.unlink(outputPath, () => {}); // Delete the file in case of an error
      reject(err);
    });
  });
};

app.listen(8080, () => {
  console.log('FFmpeg API listening on port 8080');
});
