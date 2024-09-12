const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(bodyParser.json());

const ffmpegPath = 'ffmpeg';  // Assuming ffmpeg is available in PATH, adjust if necessary
const storageDir = path.join(__dirname, 'storage');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir);
}

// Helper function to remove temporary files
function removeFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Failed to remove file ${filePath}:`, err);
      } else {
        console.log(`Removed file ${filePath}`);
      }
    });
  }
}

// Check video compatibility
function checkVideoCompatibility(videoPath) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${videoPath} -hide_banner -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -of json`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Error checking video compatibility:', error.message);
        reject(error);
      } else {
        try {
          const metadata = JSON.parse(stdout);
          const videoStream = metadata.streams[0];  // Extract first video stream info
          resolve({
            width: videoStream.width,
            height: videoStream.height,
            frameRate: videoStream.r_frame_rate,
            codec: videoStream.codec_name,
          });
        } catch (parseError) {
          console.error('Error parsing video metadata:', parseError.message);
          reject(parseError);
        }
      }
    });
  });
}

// Standardize video format
async function standardizeVideoFormat(inputVideoPath, outputVideoPath) {
  return new Promise((resolve, reject) => {
    const command = `${ffmpegPath} -i ${inputVideoPath} -vf scale=1280:720 -r 30 -c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 ${outputVideoPath}`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error('Error re-encoding video to standard format:', error.message);
        reject(error);
      } else {
        console.log('Video successfully re-encoded to standard format:', stdout);
        resolve(outputVideoPath);
      }
    });
  });
}

// Merge multiple videos
async function mergeVideos(inputVideoPaths, outputPath) {
  try {
    const videoMetadataList = await Promise.all(inputVideoPaths.map(checkVideoCompatibility));

    // Check if all videos have the same resolution, frame rate, and codec
    const firstVideoMetadata = videoMetadataList[0];
    const isCompatible = videoMetadataList.every((metadata) => (
      metadata.width === firstVideoMetadata.width &&
      metadata.height === firstVideoMetadata.height &&
      metadata.frameRate === firstVideoMetadata.frameRate &&
      metadata.codec === firstVideoMetadata.codec
    ));

    const standardizedPaths = await Promise.all(
      inputVideoPaths.map(async (videoPath) => {
        if (!isCompatible) {
          const standardizedPath = path.join(storageDir, `${uuidv4()}_standardized.mp4`);
          await standardizeVideoFormat(videoPath, standardizedPath);
          return standardizedPath;
        }
        return videoPath;
      })
    );

    // Proceed with merging the standardized videos
    const inputOptions = standardizedPaths.map((videoPath) => `-i ${videoPath}`).join(' ');
    const filterComplex = standardizedPaths.map((_, i) => `[${i}:v][${i}:a]`).join('');
    const command = `${ffmpegPath} ${inputOptions} -filter_complex "${filterComplex}concat=n=${standardizedPaths.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac -b:a 128k -ac 2 -ar 44100 -shortest ${outputPath}`;

    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          console.error('Error merging videos:', error.message);
          reject(error);
        } else {
          console.log('FFmpeg output during merging:', stdout);
          resolve(outputPath);
        }
      });
    });
  } catch (error) {
    console.error('Error in mergeVideos function:', error.message);
    throw error;
  }
}

// Route to merge videos
app.post('/merge-videos', async (req, res) => {
  const { videoUrls } = req.body;
  if (!videoUrls || videoUrls.length === 0) {
    return res.status(400).send('No video URLs provided');
  }

  try {
    // Download videos locally
    const videoPaths = await Promise.all(videoUrls.map(async (videoUrl) => {
      const videoPath = path.join(storageDir, `${uuidv4()}.mp4`);
      const command = `curl -o ${videoPath} ${videoUrl}`;
      await new Promise((resolve, reject) => {
        exec(command, (error) => {
          if (error) {
            console.error(`Error downloading video from ${videoUrl}:`, error.message);
            reject(error);
          } else {
            resolve();
          }
        });
      });
      return videoPath;
    }));

    // Merge the videos
    const outputVideoPath = path.join(storageDir, `${uuidv4()}_merged.mp4`);
    await mergeVideos(videoPaths, outputVideoPath);

    // Send back the merged video URL
    const mergedVideoUrl = `/storage/${path.basename(outputVideoPath)}`;
    res.json({ mergedVideoUrl });

    // Clean up temporary video files
    videoPaths.forEach(removeFile);
  } catch (error) {
    console.error('Error handling video merging request:', error.message);
    res.status(500).send('Error merging videos');
  }
});

// Serve merged videos
app.use('/storage', express.static(storageDir));

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
