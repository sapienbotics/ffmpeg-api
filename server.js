const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Helper function to download files
const downloadFile = async (url, outputPath) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
  const fileStream = fs.createWriteStream(outputPath);
  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
  });
};

// Endpoint to trim video
app.post('/trim-video', async (req, res) => {
  const { inputVideo, startTime, duration } = req.body;

  if (!inputVideo || !startTime || !duration) {
    return res.status(400).send('Missing required parameters.');
  }

  const tempFile = path.join(__dirname, 'temp', uuidv4() + '_temp_video.mp4');
  const trimmedFile = path.join(__dirname, 'temp', uuidv4() + '_trimmed_video.mp4');

  try {
    // Download the input video
    await downloadFile(inputVideo, tempFile);

    // Trim the video
    await new Promise((resolve, reject) => {
      ffmpeg(tempFile)
        .setStartTime(startTime)
        .setDuration(duration)
        .output(trimmedFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send response with the trimmed video URL
    res.json({ videoUrl: `https://yourserver.com/download/${path.basename(trimmedFile)}` });

  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).send('Error processing video.');
  }
});

// Endpoint to merge videos
app.post('/merge-videos', async (req, res) => {
  const { videoUrls } = req.body;

  if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length < 2) {
    return res.status(400).send('Invalid video URLs.');
  }

  const inputFiles = videoUrls.map(url => {
    const filePath = path.join(__dirname, 'temp', uuidv4() + '_input_video.mp4');
    return { url, filePath };
  });

  try {
    // Download all input videos
    await Promise.all(inputFiles.map(async ({ url, filePath }) => await downloadFile(url, filePath)));

    // Create file list for merging
    const mergeCommand = inputFiles.map(file => `file '${file.filePath}'`).join('\n');
    const fileListPath = path.join(__dirname, 'temp', 'filelist.txt');
    fs.writeFileSync(fileListPath, mergeCommand);

    // Merge videos
    const mergedFile = path.join(__dirname, 'temp', uuidv4() + '_merged_video.mp4');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(fileListPath)
        .inputFormat('concat')
        .videoCodec('copy')
        .audioCodec('copy')
        .output(mergedFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send response with the merged video URL
    res.json({ videoUrl: `https://yourserver.com/download/${path.basename(mergedFile)}` });

  } catch (error) {
    console.error('Error processing videos:', error);
    res.status(500).send('Error processing videos.');
  }
});

// Endpoint to remove audio
app.post('/remove-audio', async (req, res) => {
  const { inputVideo } = req.body;

  if (!inputVideo) {
    return res.status(400).send('Missing input video URL.');
  }

  const tempFile = path.join(__dirname, 'temp', uuidv4() + '_temp_video.mp4');
  const outputFile = path.join(__dirname, 'temp', uuidv4() + '_no_audio_video.mp4');

  try {
    // Download the input video
    await downloadFile(inputVideo, tempFile);

    // Remove audio from the video
    await new Promise((resolve, reject) => {
      ffmpeg(tempFile)
        .noAudio()
        .output(outputFile)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send response with the video URL without audio
    res.json({ outputFile: `https://yourserver.com/download/${path.basename(outputFile)}` });

  } catch (error) {
    console.error('Error processing video:', error);
    res.status(500).send('Error processing video.');
  }
});

// Endpoint to handle video processing with audio merging
app.post('/process-video', async (req, res) => {
  const { inputVideo, audioUrls } = req.body;

  if (!inputVideo || !audioUrls || !Array.isArray(audioUrls)) {
    return res.status(400).send('Missing input video or audio URLs.');
  }

  const tempVideo = path.join(__dirname, 'temp', uuidv4() + '_temp_video.mp4');
  const tempAudioFiles = audioUrls.map(url => ({
    url,
    filePath: path.join(__dirname, 'temp', uuidv4() + '_audio.mp3')
  }));
  const outputVideo = path.join(__dirname, 'temp', uuidv4() + '_final_video.mp4');

  try {
    // Download the input video and audio files
    await downloadFile(inputVideo, tempVideo);
    await Promise.all(tempAudioFiles.map(async ({ url, filePath }) => await downloadFile(url, filePath)));

    // Merge audio and video
    const filterComplex = tempAudioFiles.map(({ filePath }) => `[0:v][${filePath}]amix=inputs=1:duration=longest`).join(';');
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideo)
        .complexFilter(filterComplex)
        .output(outputVideo)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send response with the processed video URL
    res.json({ videoUrl: `https://yourserver.com/download/${path.basename(outputVideo)}` });

  } catch (error) {
    console.error('Error processing video and audio:', error);
    res.status(500).send('Error processing video and audio.');
  }
});

// Serve files for download
app.use('/download', express.static(path.join(__dirname, 'temp'), {
  setHeaders: (res, path) => {
    res.setHeader('Content-Disposition', `attachment; filename=${path.basename(path)}`);
  }
}));

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
