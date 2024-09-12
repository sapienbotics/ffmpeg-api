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

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

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

function logFileProperties(filePath) {
  try {
    const output = execSync(`${ffmpegPath} -v error -show_format -show_streams ${filePath}`).toString();
    console.log(`File properties for ${filePath}:\n`, output);
  } catch (error) {
    console.error(`Error logging properties for ${filePath}:`, error.message);
  }
}

function preprocessAudio(inputAudioPath, outputAudioPath, volume) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputAudioPath} -ar 44100 -ac 2 -filter:a "volume=${volume}" ${outputAudioPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during audio preprocessing:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during audio preprocessing:', stdout);
        resolve();
      }
    });
  });
}

function convertToCommonFormat(inputVideoPath, outputVideoPath) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -c:v libx264 -c:a aac -strict -2 ${outputVideoPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during format conversion:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during format conversion:', stdout);
        resolve();
      }
    });
  });
}

function executeFFmpegCommand(inputVideoPath, inputAudioPath, backgroundAudioPath, outputPath, options) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -i ${inputAudioPath} -i ${backgroundAudioPath} ` +
      `-filter_complex "[1:a]volume=${options.inputAudioVolume}[a1]; ` +
      `[2:a]volume=${options.backgroundAudioVolume}[a2]; ` +
      `[a1][a2]amix=inputs=2[a]" ` +
      `-map 0:v -map "[a]" ` +
      `-c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest -report ${outputPath}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during merging:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during merging:', stdout);
        resolve();
      }
    });
  });
}

function trimVideo(inputVideoPath, outputVideoPath, startTime, duration) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -ss ${startTime} -t ${duration} -c copy ${outputVideoPath}`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during trimming:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during trimming:', stdout);
        resolve();
      }
    });
  });
}

function mergeVideos(inputVideoPaths, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Convert each video to a common format
      const convertedPaths = await Promise.all(
        inputVideoPaths.map(async (videoPath) => {
          const convertedPath = `${videoPath}_converted.mp4`;
          await convertToCommonFormat(videoPath, convertedPath);
          return convertedPath;
        })
      );

      const inputOptions = convertedPaths.map((videoPath) => `-i ${videoPath}`).join(' ');
      const filterComplex = convertedPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
      const command = `${ffmpegPath} ${inputOptions} -filter_complex "${filterComplex}concat=n=${convertedPaths.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest ${outputPath}`;

      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('FFmpeg error during merging:', error.message);
          console.error('FFmpeg stderr:', stderr);
          reject(error);
        } else {
          console.log('FFmpeg output during merging:', stdout);
          resolve();
        }
      });

    } catch (error) {
      reject(error);
    }
  });
}

app.post('/edit-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const inputVideoUrl = req.body.inputVideo;
    const inputAudioUrl = req.body.inputAudio;
    const backgroundAudioUrl = req.body.backgroundAudio;
    const volume = req.body.volume || '1';  // Default volume to 1 if not provided
    const uniqueFilename = `${uuidv4()}_processed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_temp_audio.mp3`);
    const tempBackgroundAudioPath = path.join(storageDir, `${uuidv4()}_temp_background_audio.mp3`);
    const processedAudioPath = path.join(storageDir, `${uuidv4()}_processed_audio.mp4`);

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);
    console.log('Downloading audio from:', inputAudioUrl);
    await downloadFile(inputAudioUrl, tempAudioPath);
    console.log('Downloading background audio from:', backgroundAudioUrl);
    await downloadFile(backgroundAudioUrl, tempBackgroundAudioPath);

    logFileProperties(tempVideoPath);
    logFileProperties(tempAudioPath);
    logFileProperties(tempBackgroundAudioPath);

    console.log('Preprocessing main audio...');
    await preprocessAudio(tempAudioPath, processedAudioPath, volume);

    console.log('Processing video with audio...');
    const options = {
      inputAudioVolume: req.body.inputAudioVolume || '1.0',
      backgroundAudioVolume: req.body.backgroundAudioVolume || '0.0',
    };
    await executeFFmpegCommand(tempVideoPath, processedAudioPath, tempBackgroundAudioPath, outputFilePath, options);

    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp video file:', err.message);
    });
    fs.unlink(tempAudioPath, (err) => {
      if (err) console.error('Error deleting temp audio file:', err.message);
    });
    fs.unlink(tempBackgroundAudioPath, (err) => {
      if (err) console.error('Error deleting temp background audio file:', err.message);
    });
    fs.unlink(processedAudioPath, (err) => {
      if (err) console.error('Error deleting processed audio file:', err.message);
    });

    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ error: 'Error processing video' });
  }
});

app.post('/merge-videos', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const videoUrls = req.body.videoUrls; // Expect an array of video URLs
    if (!Array.isArray(videoUrls) || videoUrls.length < 2) {
      return res.status(400).json({ error: 'At least two video URLs are required' });
    }

    const uniqueFilename = `${uuidv4()}_merged_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);

    // Download each video
    const tempVideoPaths = await Promise.all(
      videoUrls.map(async (url) => {
        const tempPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
        await downloadFile(url, tempPath);
        return tempPath;
      })
    );

    console.log('Merging videos...');
    await mergeVideos(tempVideoPaths, outputFilePath);

    // Clean up temporary files
    tempVideoPaths.forEach((filePath) => {
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting temp video file:', err.message);
      });
    });

    res.json({ message: 'Videos merged successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: 'Error merging videos' });
  }
});

app.post('/trim-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const inputVideoUrl = req.body.inputVideo;
    const startTime = req.body.startTime;
    const duration = req.body.duration;
    const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    console.log('Trimming video...');
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp video file:', err.message);
    });

    res.json({ message: 'Video trimmed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error trimming video:', error.message);
    res.status(500).json({ error: 'Error trimming video' });
  }
});

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
