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

function resizeAndMergeVideos(videoData, outputPath, orientation) {
  return new Promise((resolve, reject) => {
    console.log('Video data for merging:', videoData);

    let targetAspectRatio;
    switch (orientation) {
      case 'portrait':
        targetAspectRatio = 9 / 16;
        break;
      case 'landscape':
        targetAspectRatio = 16 / 9;
        break;
      case 'square':
        targetAspectRatio = 1; // 1:1 aspect ratio
        break;
      default:
        return reject(new Error('Invalid orientation'));
    }

    // Correct mapping of input video files
    const inputOptions = videoData.map(video => `-i ${video.path}`).join(' ');

    console.log('Input options:', inputOptions);

    // Construct filter_complex dynamically based on input video dimensions
    const filterComplex = videoData.map((video, i) => {
      const aspectRatio = video.width / video.height;
      let padWidth = video.width;
      let padHeight = video.height;

      // Calculate padding based on the difference between the target and actual aspect ratios
      if (aspectRatio > targetAspectRatio) {
        // Video is wider than the target aspect ratio
        padHeight = Math.round(video.width / targetAspectRatio);
      } else if (aspectRatio < targetAspectRatio) {
        // Video is taller than the target aspect ratio
        padWidth = Math.round(video.height * targetAspectRatio);
      }

      const paddingX = Math.round((padWidth - video.width) / 2);
      const paddingY = Math.round((padHeight - video.height) / 2);

      // Dynamic padding option for FFmpeg
      const dynamicPadding = `pad=${padWidth}:${padHeight}:${paddingX}:${paddingY}:color=black`;

      return `[${i}:v]scale=${video.width}:${video.height},${dynamicPadding}[v${i}]`;
    }).join('; ') + `; ${videoData.map((_, i) => `[v${i}]`).join('')}concat=n=${videoData.length}:v=1 [v]`;

    console.log('Filter complex:', filterComplex);

    const command = `${ffmpegPath} ${inputOptions} -filter_complex "${filterComplex}" -map "[v]" -an -c:v libx264 -shortest ${outputPath}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error during resizing and merging:', error.message);
        console.error('FFmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('FFmpeg output during resizing and merging:', stdout);
        resolve();
      }
    });
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

    // Clean up temporary files
    [tempVideoPath, tempAudioPath, tempBackgroundAudioPath, processedAudioPath].forEach((filePath) => {
      fs.unlink(filePath, (err) => {
        if (err) console.error('Error deleting temp file:', err.message);
      });
    });

    res.json({ message: 'Video processed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ error: 'Error processing video' });
  }
});

app.post('/trim-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const videoUrl = req.body.videoUrl;
    const startTime = req.body.startTime;
    const duration = req.body.duration;

    if (!videoUrl || !startTime || !duration) {
      return res.status(400).json({ error: 'Missing videoUrl, startTime, or duration' });
    }

    const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_trim_video.mp4`);
    const outputFilePath = path.join(storageDir, uniqueFilename);

    console.log('Downloading video from:', videoUrl);
    await downloadFile(videoUrl, tempVideoPath);

    console.log('Trimming video...');
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    // Clean up temporary files
    fs.unlink(tempVideoPath, (err) => {
      if (err) console.error('Error deleting temp file:', err.message);
    });

    res.json({ message: 'Video trimmed successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error trimming video:', error.message);
    res.status(500).json({ error: 'Error trimming video' });
  }
});

app.post('/merge-videos', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const { videos, orientation } = req.body;
    if (!videos || !orientation) {
      return res.status(400).json({ error: 'Missing videos or orientation' });
    }

    const uniqueFilename = `${uuidv4()}_merged_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);

    const videoData = await Promise.all(videos.map(async (video) => {
      const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
      await downloadFile(video.url, tempVideoPath);
      return {
        path: tempVideoPath,
        width: video.width,
        height: video.height,
      };
    }));

    console.log('Merging videos...');
    await resizeAndMergeVideos(videoData, outputFilePath, orientation);

    // Clean up temporary video files
    videoData.forEach((video) => {
      fs.unlink(video.path, (err) => {
        if (err) console.error('Error deleting temp file:', err.message);
      });
    });

    res.json({ message: 'Videos merged successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: 'Error merging videos' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
