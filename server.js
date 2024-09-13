const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

const storageDir = process.env.STORAGE_DIR || '/app/storage/processed';

// Ensure storage directory exists
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Function to download a file with retries
async function downloadFile(url, outputPath) {
  let retries = 3;
  while (retries > 0) {
    try {
      const response = await axios.get(url, { responseType: 'stream' });
      response.data.pipe(fs.createWriteStream(outputPath));
      return new Promise((resolve, reject) => {
        response.data.on('end', resolve);
        response.data.on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading file, retrying...', error.message);
      retries--;
      if (retries === 0) throw new Error('Failed to download file after retries');
    }
  }
}

// Validate file type using MIME type
function validateFileType(filePath) {
  try {
    const output = execSync(`${ffmpegPath} -i ${filePath} -hide_banner`).toString();
    if (!output.includes('Video') && !output.includes('Audio')) {
      throw new Error('Invalid file type');
    }
    console.log(`File type validated: ${filePath}`);
  } catch (error) {
    console.error(`File validation failed for ${filePath}:`, error.message);
    throw error;
  }
}

// Function to check compatibility of videos (resolution, codec, frame rate)
function checkVideoCompatibility(videoPaths) {
  try {
    let videoProps = [];
    videoPaths.forEach(videoPath => {
      const output = execSync(`${ffmpegPath} -v error -select_streams v:0 -show_entries stream=width,height,codec_name,r_frame_rate -of default=noprint_wrappers=1 ${videoPath}`).toString();
      console.log(`Video properties for ${videoPath}:\n`, output);
      const [width, height, codec, frameRate] = output.match(/\d+/g);
      videoProps.push({ width, height, codec, frameRate });
    });

    const { width, height, codec, frameRate } = videoProps[0];
    for (let i = 1; i < videoProps.length; i++) {
      const video = videoProps[i];
      if (video.width !== width || video.height !== height || video.codec !== codec || video.frameRate !== frameRate) {
        throw new Error(`Video ${i + 1} does not match in resolution, codec, or frame rate.`);
      }
    }
    console.log('All videos are compatible for merging.');
  } catch (error) {
    console.error('Video compatibility check failed:', error.message);
    throw error;
  }
}

// Preprocess audio with volume adjustment
function preprocessAudio(inputAudioPath, outputAudioPath, volume) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputAudioPath} -ar 44100 -ac 2 -filter:a "volume=${volume}" ${outputAudioPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during audio preprocessing:', error.message);
        reject(error);
      } else {
        console.log('Audio preprocessed:', stdout);
        resolve();
      }
    });
  });
}

// Merge videos after compatibility check
async function mergeVideos(inputVideoPaths, outputPath) {
  try {
    checkVideoCompatibility(inputVideoPaths);

    const inputOptions = inputVideoPaths.map((videoPath) => `-i ${videoPath}`).join(' ');
    const filterComplex = inputVideoPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
    const command = `${ffmpegPath} ${inputOptions} -filter_complex "${filterComplex}concat=n=${inputVideoPaths.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest ${outputPath}`;
    
    await execAsync(command);
    console.log('Videos merged successfully');
  } catch (error) {
    console.error('Error during video merging:', error.message);
    throw error;
  }
}

// Trim video to specified duration
function trimVideo(inputVideoPath, outputVideoPath, duration) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -t ${duration} -c copy ${outputVideoPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Error during video trimming:', error.message);
        reject(error);
      } else {
        console.log('Video trimmed successfully:', stdout);
        resolve();
      }
    });
  });
}

// Function to delete files with error handling
async function deleteFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
    console.log(`Deleted file: ${filePath}`);
  } catch (error) {
    console.error(`Failed to delete file ${filePath}:`, error.message);
  }
}

// FFmpeg command executor wrapped in a promise
function execAsync(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', error.message);
        reject(error);
      } else {
        console.log('FFmpeg output:', stdout);
        resolve();
      }
    });
  });
}

// Example route: Merging videos with improvements
app.post('/merge-videos', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const videoUrls = req.body.videoUrls; // Expect an array of video URLs
    if (!Array.isArray(videoUrls) || videoUrls.length < 2) {
      return res.status(400).json({ error: 'At least two video URLs are required' });
    }

    const uniqueFilename = `${uuidv4()}_merged_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);

    // Download each video and validate file type
    const tempVideoPaths = await Promise.all(
      videoUrls.map(async (url) => {
        const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
        await downloadFile(url, tempVideoPath);
        validateFileType(tempVideoPath);
        return tempVideoPath;
      })
    );

    // Merge videos
    await mergeVideos(tempVideoPaths, outputFilePath);

    // Clean up temp files
    await Promise.all(tempVideoPaths.map(filePath => deleteFile(filePath)));

    res.json({ message: 'Videos merged successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: 'Error merging videos' });
  }
});

// Example route: Trimming a video
app.post('/trim-video', async (req, res) => {
  try {
    const { videoUrl, duration } = req.body;

    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const outputVideoPath = path.join(storageDir, `${uuidv4()}_trimmed_video.mp4`);

    await downloadFile(videoUrl, tempVideoPath);
    validateFileType(tempVideoPath);

    await trimVideo(tempVideoPath, outputVideoPath, duration);

    // Clean up temp file
    await deleteFile(tempVideoPath);

    res.json({ message: 'Video trimmed successfully', outputFile: outputVideoPath });
  } catch (error) {
    console.error('Error trimming video:', error.message);
    res.status(500).json({ error: 'Error trimming video' });
  }
});

// Shutdown hook for graceful exit
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

const server = app.listen(8080, () => {
  console.log('Server is running on port 8080');
});
