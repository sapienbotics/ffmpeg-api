const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const checkDiskSpace = require('check-disk-space').default;

const app = express();
app.use(express.json());

const storageDir = process.env.STORAGE_DIR || '/app/storage/processed';

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

async function mergeVideos(inputPaths, outputPath) {
  try {
    const listFilePath = path.join(storageDir, `file_list.txt`);
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);

    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy ${outputPath}`;
    console.log('Executing FFmpeg command:', command);

    await execPromise(command);

    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    throw new Error('Error merging videos: ' + error.message);
  }
}

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// Log system CPU and memory usage
function logSystemStats() {
  const memoryUsage = process.memoryUsage();
  const totalMem = os.totalmem() / (1024 * 1024); // in MB
  const freeMem = os.freemem() / (1024 * 1024); // in MB
  const usedMem = totalMem - freeMem;

  console.log(`Memory Usage: ${usedMem.toFixed(2)}MB / ${totalMem.toFixed(2)}MB`);
  
  const cpus = os.cpus();
  console.log('CPU Cores:', cpus.length);
}

app.post('/merge-videos', async (req, res) => {
  try {
    const { videos } = req.body;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty video URLs array.' });
    }

    console.log('Request received:', req.body);

    // Clean and validate video URLs
    const validVideos = videos.filter(url => typeof url === 'string' && url.trim() !== '');
    if (validVideos.length === 0) {
      return res.status(400).json({ error: 'No valid video URLs provided.' });
    }

    console.log('Valid Video URLs:', validVideos);

    // Check available disk space before processing
    const diskSpace = await checkDiskSpace(storageDir);
    console.log(`Disk Space - Free: ${(diskSpace.free / (1024 * 1024)).toFixed(2)}MB, Total: ${(diskSpace.size / (1024 * 1024)).toFixed(2)}MB`);

    if (diskSpace.free < 500 * 1024 * 1024) { // 500MB threshold
      return res.status(500).json({ error: 'Not enough disk space to process the request.' });
    }

    // Log system CPU and memory usage
    logSystemStats();

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
    validVideos.forEach(filePath => fs.existsSync(filePath) && fs.unlinkSync(filePath));
  }
});

app.listen(8080, () => {
  console.log('Server is running on port 8080');
});
