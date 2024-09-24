const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');

const app = express();
app.use(express.json());

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

const execPromise = util.promisify(exec);

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

const processMedia = async (mediaList) => {
  const imagePaths = [];
  const videoPaths = [];

  for (const media of mediaList) {
    const ext = path.extname(media.url).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filePath = ext === '.mp4' ? path.join(videosDir, filename) : path.join(imagesDir, filename);

    await downloadFile(media.url, filePath);
    if (ext === '.mp4') {
      videoPaths.push(filePath);
    } else {
      imagePaths.push(filePath);
    }
  }

  return { imagePaths, videoPaths };
};

const trimVideo = async (inputPath, outputPath, startTime, duration) => {
  try {
    const command = `ffmpeg -i "${inputPath}" -ss ${startTime} -t ${duration} -c:v libx264 -c:a aac "${outputPath}"`;
    await execPromise(command);
  } catch (error) {
    console.error('Error trimming video:', error);
    throw error;
  }
};

const resizeVideo = async (inputPath, outputPath, width, height) => {
  try {
    const command = `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}" -c:v libx264 -c:a aac "${outputPath}"`;
    await execPromise(command);
  } catch (error) {
    console.error('Error resizing video:', error);
    throw error;
  }
};

const editVideo = async (inputPath, outputPath, edits) => {
  try {
    let filters = '';
    if (edits.crop) {
      filters += `crop=${edits.crop}`;
    }
    if (edits.scale) {
      filters += `${filters ? ',' : ''}scale=${edits.scale}`;
    }

    const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -c:a aac "${outputPath}"`;
    await execPromise(command);
  } catch (error) {
    console.error('Error editing video:', error);
    throw error;
  }
};

const mergeVideos = async (inputPaths, outputPath) => {
  try {
    const listFilePath = path.join(storageDir, 'file_list.txt');
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listFilePath, fileListContent);

    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c copy -y ${outputPath} -progress ${path.join(storageDir, 'ffmpeg_progress.log')} -loglevel verbose`;
    await execPromise(command, 600000); // 10 minutes timeout

    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    console.error('Error merging videos:', error);
    throw error;
  }
};

const downloadImage = async (imageUrl, downloadDir) => {
  try {
    const uniqueId = crypto.randomBytes(8).toString('hex');
    let extension = path.extname(imageUrl).split('?')[0];
    if (!extension) {
      extension = '.jpg'; // Default to .jpg if no extension is found
    }

    const sanitizedFilename = `${uniqueId}${extension}`;
    const filePath = path.join(downloadDir, sanitizedFilename);

    const response = await axios({
      url: imageUrl,
      method: 'GET',
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://example.com' // Adjust the referer if needed
      },
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Resolve only if status code is 2xx to 3xx
      },
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(filePath));
      writer.on('error', reject);
    });
  } catch (error) {
    console.error(`Error downloading image: ${error.message}`);
    return null; // Return null to indicate a failure
  }
};

app.post('/merge-media-sequence', async (req, res) => {
  try {
    const { mediaSequence } = req.body;

    if (!mediaSequence || !Array.isArray(mediaSequence)) {
      return res.status(400).json({ error: 'Invalid mediaSequence input. It must be an array of media objects.' });
    }

    const processedMedia = [];

    for (const media of mediaSequence) {
      const { url, duration, type } = media;

      if (type === 'image') {
        const tempImagePath = await downloadImage(url, imagesDir);

        if (tempImagePath) {
          const tempVideoPath = path.join(videosDir, `${uuidv4()}_temp_video.mp4`);
          const command = `ffmpeg -loop 1 -i "${tempImagePath}" -c:v libx264 -t ${duration} -pix_fmt yuv420p ${tempVideoPath}`;
          await execPromise(command);

          processedMedia.push(tempVideoPath);
        }
      } else if (type === 'video') {
        const tempVideoPath = await downloadFile(url, videosDir);
        const trimmedVideoPath = path.join(videosDir, `${uuidv4()}_trimmed_video.mp4`);
        await trimVideo(tempVideoPath, trimmedVideoPath, 0, duration);

        processedMedia.push(trimmedVideoPath);
      }
    }

    const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
    await mergeVideos(processedMedia, outputFilePath);

    res.status(200).json({ message: 'Media sequence merged successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing merge-media-sequence request:', error.message);
    res.status(500).json({ error: 'An error occurred while merging the media sequence.' });
  }
});

app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(storageDir, filename);

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});