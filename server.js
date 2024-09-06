const express = require('express');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

app.post('/edit-video', (req, res) => {
  const { inputFile, outputFile, options } = req.body;

  // Build the FFmpeg command
  const command = `ffmpeg -i ${inputFile} ${options} ${outputFile}`;

  // Run FFmpeg command
  exec(command, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send({ error: error.message });
    }
    if (stderr) {
      return res.status(500).send({ error: stderr });
    }
    res.send({ message: 'Video processed successfully', output: stdout });
  });
});

app.listen(8080, () => {
  console.log('FFmpeg API listening on port 8080');
});
