const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(express.json());

// Directory to store uploaded and processed files
const storageDir = process.env.STORAGE_DIR || 'storage/processed';

if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Serve video files from the storage directory
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(storageDir, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send('File not found');
  }
});

// Download file utility function
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
      console.error(`Error downloading file from ${url}:`, error.message);
      if (error.response && error.response.status === 404) {
        console.error('File not found at the URL:', url);
      }
      retries--;
      if (retries === 0) throw new Error(`Failed to download file from ${url} after retries`);
    }
  }
}

// Log file properties utility function
function logFileProperties(filePath) {
  try {
    const output = execSync(`${ffmpegPath} -v error -show_format -show_streams ${filePath}`).toString();
    console.log(`File properties for ${filePath}:\n`, output);
  } catch (error) {
    console.error(`Error logging properties for ${filePath}:`, error.message);
  }
}

// Preprocess audio utility function
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

// Execute FFmpeg command utility function
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

// Trim video utility function
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

// Resize and merge videos utility function
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

    const inputOptions = videoData.map(video => `-i ${video.path}`).join(' ');

    console.log('Input options:', inputOptions);

    const filterComplex = videoData.map((video, i) => {
      const aspectRatio = video.width / video.height;
      let padWidth = video.width;
      let padHeight = video.height;

      if (aspectRatio > targetAspectRatio) {
        padHeight = Math.round(video.width / targetAspectRatio);
      } else if (aspectRatio < targetAspectRatio) {
        padWidth = Math.round(video.height * targetAspectRatio);
      }

      const paddingX = Math.round((padWidth - video.width) / 2);
      const paddingY = Math.round((padHeight - video.height) / 2);

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

// Endpoint to process video with audio
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
      inputAudioVolume: req.body.inputAudioVolume || 1,
      backgroundAudioVolume: req.body.backgroundAudioVolume || 1
    };
    await executeFFmpegCommand(tempVideoPath, processedAudioPath, tempBackgroundAudioPath, outputFilePath, options);

    console.log('Cleaning up temporary files...');
    fs.unlinkSync(tempVideoPath);
    fs.unlinkSync(tempAudioPath);
    fs.unlinkSync(tempBackgroundAudioPath);
    fs.unlinkSync(processedAudioPath);

    res.status(200).json({ message: 'Video processed successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to merge videos
app.post('/merge-videos', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const videoData = req.body.videos;
    const orientation = req.body.orientation;

    if (!videoData || !orientation) {
      throw new Error('Missing videos or orientation');
    }

    const uniqueFilename = `${uuidv4()}_merged_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);

    await resizeAndMergeVideos(videoData, outputFilePath, orientation);

    res.json({ message: 'Videos merged successfully', outputFile: uniqueFilename });
  } catch (error) {
    console.error('Error merging videos:', error.message);
    res.status(500).json({ error: 'Error merging videos' });
  }
});

// Endpoint to trim video
app.post('/trim-video', async (req, res) => {
  try {
    console.log('Request received:', req.body);
    const inputVideoUrl = req.body.inputVideo;
    const startTime = req.body.startTime;
    const duration = req.body.duration;
    
    if (!inputVideoUrl || !startTime || !duration) {
      throw new Error('Missing inputVideo, startTime, or duration');
    }

    const uniqueFilename = `${uuidv4()}_trimmed_video.mp4`;
    const outputFilePath = path.join(storageDir, uniqueFilename);
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);

    console.log('Downloading video from:', inputVideoUrl);
    await downloadFile(inputVideoUrl, tempVideoPath);

    console.log('Trimming video...');
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    console.log('Cleaning up temporary files...');
    fs.unlinkSync(tempVideoPath);

    res.status(200).json({ message: 'Video trimmed successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error trimming video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
