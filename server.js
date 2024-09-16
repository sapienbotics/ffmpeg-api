const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

// Set storage directory for Railway environment
const storageDir = '/app/storage/processed';

// Download video file
const downloadFile = async (url, filepath) => {
  const writer = fs.createWriteStream(filepath);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
};

// Merge videos
async function mergeVideos(inputPaths, outputPath) {
  try {
    const listFilePath = path.join(storageDir, 'file_list.txt');
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);

    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy ${outputPath} -progress ${path.join(storageDir, 'ffmpeg_progress.log')} -loglevel verbose`;
    console.log('Executing FFmpeg command:', command);

    await execPromise(command, 600000); // 10 minutes timeout

    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    throw new Error('Error merging videos: ' + error.message);
  }
}

// Execute shell command and handle timeout
function execPromise(command, timeout) {
  return new Promise((resolve, reject) => {
    const child = exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });

    // Set a timeout for the command
    setTimeout(() => {
      child.kill('SIGTERM'); // Terminate the process if it exceeds the timeout
      reject(new Error('FFmpeg process timed out'));
    }, timeout);
  });
}

app.post('/merge-videos', async (req, res) => {
  let validVideos = []; // Define validVideos here

  try {
    const { videos } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty video URLs array.' });
    }

    console.log('Request received:', req.body);

    // Clean and validate video URLs
    validVideos = videos.filter(url => typeof url === 'string' && url.trim() !== '');
    if (validVideos.length === 0) {
      return res.status(400).json({ error: 'No valid video URLs provided.' });
    }

    console.log('Valid Video URLs:', validVideos);

    const downloadPromises = validVideos.map((url, index) => {
      const filepath = path.join(storageDir, `video${index + 1}.mp4`);
      console.log(`Downloading file from URL: ${url}`);
      return downloadFile(url, filepath).then(() => filepath);
    });

    const downloadedFiles = await Promise.all(downloadPromises);

    // Merge the videos using the mergeVideos function
    const outputFilePath = path.join(storageDir, 'merged_output.mp4');
    await mergeVideos(downloadedFiles, outputFilePath);

    console.log('Video merge completed:', outputFilePath);
    res.json({ message: 'Videos merged successfully!', mergedVideo: outputFilePath });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: 'Server error.' });
  } finally {
    // Cleanup temporary files
    if (validVideos.length > 0) {
      validVideos.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
    }
  }
});

app.listen(8080, () => {
  console.log('Server is running on port 8080');
});
