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

const trimVideo = async (inputPath, outputPath, duration) => {
  try {
    // Audio removal (-an) included in the trimming process.
    const command = `ffmpeg -i "${inputPath}" -ss 0 -t ${duration} -c:v libx264 -an "${outputPath}"`;
    await execPromise(command);
  } catch (error) {
    console.error('Error trimming video:', error);
    throw error;
  }
};

const resizeVideo = async (inputPath, outputPath, width, height) => {
  try {
    // Audio removal (-an) included in the resizing process.
    const command = `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}" -c:v libx264 -an "${outputPath}"`;
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

    // Audio removal (-an) included in the editing process.
    const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -an "${outputPath}"`;
    await execPromise(command);
  } catch (error) {
    console.error('Error editing video:', error);
    throw error;
  }
};

const mergeVideos = async (inputPaths, outputPath) => {
  try {
    // Check if all file paths exist before merging videos
    for (const mediaPath of inputPaths) {
      if (!fs.existsSync(mediaPath)) {
        throw new Error(`File not found: ${mediaPath}`);
      }
    }

    const listFilePath = path.join(storageDir, 'file_list.txt');
    const fileListContent = inputPaths.map(p => `file '${p}'`).join('\n');
    console.log('File list contents:', fileListContent);
    fs.writeFileSync(listFilePath, fileListContent);

    // Re-encoding all videos for consistency to avoid codec issues, adding audio removal (-an).
    const command = `ffmpeg -f concat -safe 0 -i ${listFilePath} -c:v libx264 -an -y ${outputPath}`;
    const { stdout, stderr } = await execPromise(command);

    if (stderr) {
      console.error(`Error merging videos: ${stderr}`);
    }

    fs.unlinkSync(listFilePath); // Clean up the list file
  } catch (error) {
    console.error('Error merging videos:', error);
    throw error;
  }
};

const downloadImage = async (imageUrl, downloadDir) => {
  try {
    const uniqueId = uuidv4();
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

const getAudioDuration = async (audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error('Error fetching audio metadata:', err);
        reject(err);
      } else {
        const duration = metadata.format.duration;
        resolve(duration);
      }
    });
  });
};

app.post('/get-audio-duration', async (req, res) => {
  try {
    const { audioUrl } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'Missing audio URL.' });
    }

    const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);
    await downloadFile(audioUrl, tempAudioPath);

    const duration = await getAudioDuration(tempAudioPath);
    fs.unlinkSync(tempAudioPath);

    res.json({ duration });
  } catch (error) {
    console.error('Error processing get-audio-duration request:', error.message);
    res.status(500).json({ error: 'Failed to retrieve audio duration.' });
  }
});

app.post('/merge-media-sequence', async (req, res) => {
  try {
    // Check if all file paths exist before merging videos
    for (const media of req.body.mediaSequence) {
      if (media.type === 'video' && !fs.existsSync(media.url)) {
        return res.status(400).json({ error: `Video file not found: ${media.url}` });
      }
    }

    // Proceed with merging videos
    const processedMedia = [];

    for (const media of req.body.mediaSequence) {
      const { url, duration, type } = media;

      if (type === 'image') {
        const tempImagePath = await downloadImage(url, imagesDir);

        if (tempImagePath) {
          const tempVideoPath = path.join(videosDir, `${uuidv4()}_temp_video.mp4`);
          // Add frame rate (-r 30) and remove audio (-an).
          const command = `ffmpeg -loop 1 -i "${tempImagePath}" -c:v libx264 -t ${duration} -r 30 -pix_fmt yuv420p -an "${tempVideoPath}"`;
          await execPromise(command);

          processedMedia.push(tempVideoPath);
        }
      } else if (type === 'video') {
        const tempVideoPath = path.join(videosDir, `${uuidv4()}.mp4`);
        await downloadFile(url, tempVideoPath);
        const trimmedVideoPath = path.join(videosDir, `${uuidv4()}_trimmed_video.mp4`);
        await trimVideo(tempVideoPath, trimmedVideoPath, duration);

        processedMedia.push(trimmedVideoPath);
      }
    }

    const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_video.mp4`);
    await mergeVideos(processedMedia, outputFilePath);

    res.status(200).json({ message: 'Media sequence merged successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing merge-media-sequence request:', error.message);
    res.status(500).json({ error: 'Failed to merge media sequence.' });
  }
});


app.get('/download', (req, res) => {
  try {
    const { filename } = req.query;

    if (!filename) {
      return res.status(400).json({ error: 'Missing filename query parameter.' });
    }

    const filePath = path.join(storageDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Set the correct content type and headers for file download
    res.download(filePath, filename, (err) => {
      if (err) {
        console.error('Error sending file:', err.message);
        res.status(500).json({ error: 'Failed to download the file.' });
      }
    });
  } catch (error) {
    console.error('Error processing download request:', error.message);
    res.status(500).json({ error: 'Failed to process the download request.' });
  }
});


const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
