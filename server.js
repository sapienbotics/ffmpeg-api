const express = require('express');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const app = express();
app.use(express.json());

const execPromise = promisify(exec);
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

// Function to get video metadata like codec, pixel format, and dimensions
async function getVideoMetadata(filePath) {
  const { stdout } = await execPromise(`ffprobe -v quiet -print_format json -show_streams ${filePath}`);
  const metadata = JSON.parse(stdout);
  const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
  
  if (!videoStream) {
    throw new Error('No video stream found');
  }

  return {
    width: videoStream.width,
    height: videoStream.height,
    codec: videoStream.codec_name,
    pixelFormat: videoStream.pix_fmt,
  };
}

// Function to merge videos with optional re-encoding based on metadata
async function mergeVideos(inputPaths, outputPath) {
  try {
    const listFilePath = path.join(storageDir, `file_list.txt`);
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);

    // Use concat and only re-encode if necessary (if codec or pixel format differs)
    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy ${outputPath}`;
    console.log('Executing FFmpeg command:', command);

    await execPromise(command);
    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    throw new Error('Error merging videos: ' + error.message);
  }
}

// Function to resize or re-encode if needed
async function processVideo(inputFilePath, referenceMetadata) {
  const metadata = await getVideoMetadata(inputFilePath);

  const needsReencoding = (
    metadata.width !== referenceMetadata.width ||
    metadata.height !== referenceMetadata.height ||
    metadata.codec !== referenceMetadata.codec ||
    metadata.pixelFormat !== referenceMetadata.pixelFormat
  );

  if (needsReencoding) {
    const resizedPath = path.join(storageDir, `resized_${path.basename(inputFilePath)}`);
    const resizeCommand = `ffmpeg -i ${inputFilePath} -vf scale=${referenceMetadata.width}:${referenceMetadata.height} -c:v ${referenceMetadata.codec} -preset ultrafast -pix_fmt ${referenceMetadata.pixelFormat} ${resizedPath}`;
    console.log('Re-encoding video with command:', resizeCommand);

    await execPromise(resizeCommand);
    return resizedPath;
  }
  return inputFilePath; // No re-encoding needed
}

app.post('/merge-videos', async (req, res) => {
  try {
    const { videos } = req.body;
    if (!videos || !Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Invalid or empty video URLs array.' });
    }

    console.log('Request received:', req.body);

    // Validate and clean video URLs
    const validVideos = videos.filter(url => typeof url === 'string' && url.trim() !== '');
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

    // Get metadata of the first video to use as reference for the others
    const referenceMetadata = await getVideoMetadata(downloadedFiles[0]);

    // Re-encode or resize videos if needed
    const processedFilesPromises = downloadedFiles.map(filePath => processVideo(filePath, referenceMetadata));
    const processedFiles = await Promise.all(processedFilesPromises);

    // Merge the videos
    const outputFilePath = path.join(storageDir, 'merged_output.mp4');
    await mergeVideos(processedFiles, outputFilePath);

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
