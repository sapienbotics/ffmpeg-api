const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json());

// Set storage directories
const storageDir = '/app/storage/processed';
const imagesDir = path.join(__dirname, 'images');
const videosDir = path.join(__dirname, 'videos');

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

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

// Sanitizing function for URLs
function sanitizeFilename(url) {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname.split('/').pop();
  const ext = pathname.includes('.') ? pathname.split('.').pop() : 'jpg';
  const sanitized = uuidv4();
  return `${sanitized}.${ext}`;
}

// Download image file
async function downloadImage(imageUrl, downloadDir) {
  try {
    const filename = sanitizeFilename(imageUrl);
    const filePath = path.join(downloadDir, filename);

    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://example.com'
      },
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      },
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error('Error downloading image:', error);
    throw error;
  }
}

// Normalize video format
const normalizeVideo = async (inputPath, outputPath) => {
  const command = `ffmpeg -i ${inputPath} -vf "scale=1280:720" -r 30 -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k ${outputPath} -y`;
  console.log('Executing FFmpeg command for normalization:', command);
  await execPromise(command);
};

// Merge videos
const mergeVideos = async (inputPaths, outputPath) => {
  const listFilePath = path.join(storageDir, 'file_list.txt');
  const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(listFilePath, fileListContent);

  const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy -y ${outputPath} -progress ${path.join(storageDir, 'ffmpeg_progress.log')} -loglevel verbose`;
  console.log('Executing FFmpeg command for merging:', command);
  await execPromise(command);

  fs.unlinkSync(listFilePath);
};

// Resize video
const resizeVideo = async (inputPath, outputPath, width, height) => {
  const command = `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Edit video (crop/scale)
const editVideo = async (inputPath, outputPath, edits) => {
  let filters = '';
  if (edits.crop) filters += `crop=${edits.crop}`;
  if (edits.scale) filters += `${filters ? ',' : ''}scale=${edits.scale}`;
  const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Add audio to video
const addAudioToVideo = async (videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume, backgroundVolume) => {
  try {
    const contentVol = contentVolume || 1.0;
    const backgroundVol = backgroundVolume || 1.0;
    const command = `
      ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex \
      "[1:a]volume=${contentVol}[a1];[2:a]volume=${backgroundVol}[a2];[a1][a2]amix=inputs=2:duration=longest" \
      -c:v copy -shortest -y "${outputFilePath}"
    `;
    await execPromise(command);
    console.log('Audio added successfully');
  } catch (error) {
    console.error('Error adding audio to video:', error);
    throw error;
  }
};

// Trim video
async function trimVideo(inputPath, outputPath, startTime, duration) {
  try {
    if (!startTime || !duration) throw new Error('Invalid startTime or duration');
    const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -c:v libx264 -c:a aac "${outputPath}"`;
    console.log(`Executing command: ${command}`);
    await execPromise(command);
  } catch (error) {
    console.error('Error trimming video:', error);
    throw error;
  }
}

// Endpoints
app.post('/trim-video', async (req, res) => {
  try {
    const { inputVideoUrl, startTime, duration } = req.body;
    if (!inputVideoUrl || startTime === undefined || duration === undefined) {
      return res.status(400).json({ error: 'Missing or invalid inputVideoUrl, startTime, or duration' });
    }
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_trimmed_video.mp4`);
    await downloadFile(inputVideoUrl, tempVideoPath);
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);
    res.json({ trimmedVideoUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing trim-video request:', error);
    res.status(500).json({ error: 'An error occurred while trimming the video.' });
  }
});

app.post('/resize-video', async (req, res) => {
  try {
    const { inputVideoUrl, width, height } = req.body;
    if (!inputVideoUrl || !width || !height) {
      throw new Error('Missing input video URL, width, or height in request body');
    }
    const uniqueFilename = `${uuidv4()}_resized_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    await downloadFile(inputVideoUrl, tempVideoPath);
    await resizeVideo(tempVideoPath, outputFilePath, width, height);
    fs.unlinkSync(tempVideoPath);
    res.status(200).json({ message: 'Video resized successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error resizing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/merge-videos', async (req, res) => {
  try {
    const { videoUrls } = req.body;
    if (!videoUrls || !Array.isArray(videoUrls)) {
      throw new Error('Invalid videoUrls input. It must be an array of video URLs.');
    }
    const downloadedFiles = await Promise.all(
      videoUrls.map(async (videoUrl) => {
        const uniqueFilename = `${uuidv4()}_video.mp4`;
        const outputPath = path.join(videosDir, uniqueFilename);
        await downloadFile(videoUrl, outputPath);
        return outputPath;
      })
    );
    const mergedFileName = `${uuidv4()}_merged.mp4`;
    const outputPath = path.join(storageDir, mergedFileName);
    await mergeVideos(downloadedFiles, outputPath);
    res.status(200).json({ message: 'Videos merged successfully', outputUrl: outputPath });
  } catch (error) {
    console.error('Error merging videos:', error);
    res.status(500).json({ error: 'Failed to merge videos.' });
  }
});

app.post('/images-to-video', async (req, res) => {
  try {
    const { imageUrls, durationPerImage } = req.body;
    if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
      return res.status(400).json({ error: 'Invalid input: imageUrls must be a non-empty array.' });
    }
    const downloadedImages = await Promise.all(imageUrls.map((url) => downloadImage(url, imagesDir)));
    const uniqueFilename = `${uuidv4()}_slideshow.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const command = `ffmpeg -framerate 1/${durationPerImage} -i ${imagesDir}/%d.jpg -c:v libx264 -pix_fmt yuv420p ${outputFilePath}`;
    console.log(`Executing command: ${command}`);
    await execPromise(command);
    res.status(200).json({ message: 'Slideshow video created successfully', videoUrl: outputFilePath });
  } catch (error) {
    console.error('Error creating slideshow video:', error);
    res.status(500).json({ error: 'Failed to create slideshow video' });
  }
});

app.post('/add-audio-to-video', async (req, res) => {
  try {
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume, backgroundVolume } = req.body;
    const videoPath = path.join(storageDir, `${uuidv4()}_video.mp4`);
    const contentAudioPath = path.join(storageDir, `${uuidv4()}_content_audio.mp3`);
    const backgroundAudioPath = path.join(storageDir, `${uuidv4()}_background_audio.mp3`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_output.mp4`);

    await Promise.all([
      downloadFile(videoUrl, videoPath),
      downloadFile(contentAudioUrl, contentAudioPath),
      downloadFile(backgroundAudioUrl, backgroundAudioPath),
    ]);

    await addAudioToVideo(videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume, backgroundVolume);

    res.status(200).json({ message: 'Audio added to video successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error adding audio to video:', error);
    res.status(500).json({ error: 'Failed to add audio to video.' });
  }
});

// Download endpoint
app.get('/download', (req, res) => {
  const { fileName } = req.query;
  const filePath = path.join(storageDir, fileName);
  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Cleanup files at the start of the server
const cleanupOldFiles = (dir, olderThanMinutes) => {
  const files = fs.readdirSync(dir);
  const currentTime = Date.now();
  files.forEach(file => {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    const fileAgeInMinutes = (currentTime - stats.mtimeMs) / (1000 * 60);
    if (fileAgeInMinutes > olderThanMinutes) {
      fs.unlinkSync(filePath);
    }
  });
};

// Cleanup old files before server starts to save space
const olderThanMinutes = 1440; // 1 day old files
cleanupOldFiles(storageDir, olderThanMinutes);
cleanupOldFiles(imagesDir, olderThanMinutes);
cleanupOldFiles(videosDir, olderThanMinutes);

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
