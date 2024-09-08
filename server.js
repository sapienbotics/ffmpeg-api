const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');

// Promisify exec to use async/await
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());

// Paths to volume-mounted directories
const tempDir = '/app/storage/temp';
const outputDir = '/app/storage/processed';

// Ensure directories exist
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Helper function to delete files in a directory
function deleteFilesInDirectory(directory) {
  fs.readdir(directory, (err, files) => {
    if (err) {
      console.error('Error reading directory:', err);
      return;
    }

    files.forEach(file => {
      const filePath = path.join(directory, file);
      fs.unlink(filePath, err => {
        if (err) {
          console.error('Error deleting file:', err);
        }
      });
    });
  });
}

// Endpoint to handle video editing
app.post('/edit-video', async (req, res) => {
  try {
    const { inputVideo, outputFile, options } = req.body;

    if (!inputVideo || !outputFile || !options) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const tempInputPath = path.join(tempDir, 'temp_input_video.mp4');
    const outputFilePath = path.join(outputDir, outputFile);

    // Clean up old files in temp directory
    deleteFilesInDirectory(tempDir);

    // Remove any existing output file
    if (fs.existsSync(outputFilePath)) {
      fs.unlinkSync(outputFilePath);
    }

    // Download the input video file
    const response = await axios({
      url: inputVideo,
      responseType: 'stream',
    });
    const writer = fs.createWriteStream(tempInputPath);
    response.data.pipe(writer);

    writer.on('finish', async () => {
      try {
        // Run FFmpeg command
        const command = `ffmpeg -i ${tempInputPath} ${options} ${outputFilePath}`;
        await execPromise(command);

        // Respond with success
        res.json({ message: 'Video processed successfully', outputFile: outputFilePath });
      } catch (error) {
        console.error('Error processing video:', error);
        res.status(500).json({ error: 'Error processing video' });
      } finally {
        // Clean up temporary files
        if (fs.existsSync(tempInputPath)) {
          fs.unlinkSync(tempInputPath);
        }
      }
    });

    writer.on('error', (err) => {
      console.error('Error downloading video:', err);
      res.status(500).json({ error: 'Error downloading video' });
    });
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
