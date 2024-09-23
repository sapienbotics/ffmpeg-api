const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');
const { promisify } = require('util');
const crypto = require('crypto');



const app = express();
app.use(express.json());

// Set storage directory
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

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);


// Utility function to delete all files in a directory
const clearDirectory = (dirPath) => {
  fs.readdir(dirPath, (err, files) => {
    if (err) throw err;
    for (const file of files) {
      fs.unlink(path.join(dirPath, file), (err) => {
        if (err) throw err;
      });
    }
  });
};

// Clear directories at the start of processing
clearDirectory(imagesDir);
clearDirectory(videosDir);


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


// Process input JSON and handle images and videos
const processMedia = async (mediaList) => {
  const imagePaths = [];
  const videoPaths = [];

  for (const media of mediaList) {
    const ext = path.extname(media).toLowerCase();
    const filename = `${uuidv4()}${ext}`;
    const filePath = ext === '.mp4' ? path.join(videosDir, filename) : path.join(imagesDir, filename);

    await downloadFile(media, filePath);
    if (ext === '.mp4') {
      videoPaths.push(filePath);
    } else {
      imagePaths.push(filePath);
    }
  }

  return { imagePaths, videoPaths };
};

// Function to sanitize and truncate filenames
function sanitizeAndTruncateFilename(filename, maxLength = 100) {
  const sanitized = filename
    .replace(/[<>:"/\\|?*]+/g, '_') // Replace invalid characters with underscore
    .slice(0, maxLength); // Truncate filename to max length
  return sanitized;
}

// Function to download image
async function downloadImage(imageUrl, downloadDir) {
  try {
    // Generate a short unique identifier for the file
    const uniqueId = crypto.randomBytes(8).toString('hex');
    let extension = path.extname(imageUrl).split('?')[0];
    if (!extension) {
      extension = '.jpg'; // Default to .jpg if no extension is found
    }

    // Create a sanitized and truncated filename
    const sanitizedFilename = sanitizeAndTruncateFilename(`${uniqueId}${extension}`);
    const filePath = path.join(downloadDir, sanitizedFilename);

    // Ensure download directory exists
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    // Fetch image from URL
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

    // Create a writable stream and save the image
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
}


module.exports = { downloadImage };

// Normalize video format
const normalizeVideo = async (inputPath, outputPath) => {
  const command = `ffmpeg -i ${inputPath} -vf "scale=1280:720" -r 30 -c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k ${outputPath} -y`;
  console.log('Executing FFmpeg command for normalization:', command);

  await execPromise(command);
};


// Function to resize video using FFmpeg
const resizeVideo = async (inputPath, outputPath, width, height) => {
  const command = `ffmpeg -i "${inputPath}" -vf "scale=${width}:${height}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Function to apply edits to video (e.g., cropping) using FFmpeg
const editVideo = async (inputPath, outputPath, edits) => {
  let filters = '';
  if (edits.crop) {
    filters += `crop=${edits.crop}`;
  }
  if (edits.scale) {
    filters += `${filters ? ',' : ''}scale=${edits.scale}`;
  }

  const command = `ffmpeg -i "${inputPath}" -vf "${filters}" -c:v libx264 -c:a aac "${outputPath}"`;
  await execPromise(command);
};

// Function to download media
async function downloadMedia(mediaUrl) {
    try {
        const response = await axios.get(mediaUrl, { responseType: 'stream' });
        const filePath = `/app/storage/processed/${getFileNameFromUrl(mediaUrl)}`;
        
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(filePath));
            writer.on('error', (err) => {
                console.error(`Error downloading media from ${mediaUrl}: ${err.message}`);
                reject(err);
            });
        });
    } catch (error) {
        console.error(`Error downloading media from ${mediaUrl}: ${error.response ? error.response.statusText : error.message}`);
        return null; // Return null if there's an error
    }
}


// Helper function to get filename from URL
function getFileNameFromUrl(url) {
    return url.split('/').pop();
}



// Function to clean file name by removing query parameters
function cleanFileName(url) {
    return url.split('?')[0];  // Remove the query parameters
}


// Function to apply audio to video with fallbacks
const addAudioToVideoWithFallback = async (videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume = 1.0, backgroundVolume = 1.0) => {
  try {
    let backgroundAudioExists = true;

    // Check if background audio is missing or has issues
    if (!fs.existsSync(backgroundAudioPath)) {
      console.log('Background audio file is missing or not downloaded');
      backgroundAudioExists = false;
    } else {
      // Validate background audio format (e.g., .mp3, .wav)
      const backgroundAudioExtension = path.extname(backgroundAudioPath).toLowerCase();
      const validFormats = ['.mp3', '.wav'];
      if (!validFormats.includes(backgroundAudioExtension)) {
        console.log('Background audio format is not valid:', backgroundAudioExtension);
        backgroundAudioExists = false;
      }
    }

    // Base command to merge video with content audio
    let command = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content]" -map 0:v -map "[content]" -c:v copy -shortest -y "${outputFilePath}"`;

    if (backgroundAudioExists) {
      // Get durations of content audio and background audio
      const contentAudioDuration = await getAudioDuration(contentAudioPath);
      const backgroundAudioDuration = await getAudioDuration(backgroundAudioPath);

      if (backgroundAudioDuration < contentAudioDuration) {
        // Loop background audio if it is shorter than content audio
        command = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -stream_loop -1 -i "${backgroundAudioPath}" -filter_complex \
          "[1:a]volume=${contentVolume}[content]; [2:a]volume=${backgroundVolume}[background]; [content][background]amix=inputs=2:duration=longest[out]" \
          -map 0:v -map "[out]" -c:v copy -shortest -y "${outputFilePath}"`;
      } else {
        // No looping needed, merge normally
        command = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex \
          "[1:a]volume=${contentVolume}[content]; [2:a]volume=${backgroundVolume}[background]; [content][background]amix=inputs=2:duration=longest[out]" \
          -map 0:v -map "[out]" -c:v copy -shortest -y "${outputFilePath}"`;
      }
    }

    // Execute FFmpeg command to merge audio and video
    console.log('Executing FFmpeg command to add audio to video:', command);
    await execPromise(command);
    console.log('Audio added to video successfully');
  } catch (error) {
    console.error('Error adding audio to video:', error);
    throw error;
  }
};

// Function to get audio duration using ffmpeg
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




// Endpoint to trim the video
app.post('/trim-video', async (req, res) => {
  try {
    // Extract input parameters from request body
    const { inputVideoUrl, startTime, duration } = req.body;

    // Validate request parameters
    if (!inputVideoUrl || startTime === undefined || duration === undefined) {
      return res.status(400).json({ error: 'Missing or invalid inputVideoUrl, startTime, or duration' });
    }

    // Log the received values for debugging
    console.log(`Received inputVideoUrl: ${inputVideoUrl}, startTime: ${startTime}, duration: ${duration}`);

    // Define paths for temp and output video files
    const tempVideoPath = path.join(storageDir, `${uuidv4()}_temp_video.mp4`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_trimmed_video.mp4`);

    // Download the input video to the temp path (assuming downloadFile is defined)
    await downloadFile(inputVideoUrl, tempVideoPath);

    // Call trimVideo to perform the trimming operation
    await trimVideo(tempVideoPath, outputFilePath, startTime, duration);

    // Respond with the path to the trimmed video
    res.json({ trimmedVideoUrl: outputFilePath });

  } catch (error) {
    console.error('Error processing trim-video request:', error);
    res.status(500).json({ error: 'An error occurred while trimming the video.' });
  }
});

// Endpoint to resize video
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
    await resizeVideo(tempVideoPath, outputFilePath);

    fs.unlinkSync(tempVideoPath);
    res.status(200).json({ message: 'Video resized successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error resizing video:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to merge videos
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


// Endpoint to create a video from multiple images
app.post('/images-to-video', async (req, res) => {
  try {
    const { imageUrls, duration, additionalDuration, format } = req.body; // Accept additionalDuration and duration
    if (!imageUrls || !Array.isArray(imageUrls)) {
      return res.status(400).json({ error: 'Invalid imageUrls input. It must be an array of image URLs.' });
    }
    if (typeof duration !== 'number' || duration <= 0 || typeof additionalDuration !== 'number' || additionalDuration < 0) {
      return res.status(400).json({ error: 'Invalid duration or additionalDuration input. Duration must be a positive number and additionalDuration a non-negative number.' });
    }

    // Calculate totalDuration
    const totalDuration = duration + additionalDuration;

    // Clear the images directory before downloading new images
    fs.readdir(imagesDir, (err, files) => {
      if (err) throw err;
      for (const file of files) {
        fs.unlink(path.join(imagesDir, file), (err) => {
          if (err) throw err;
        });
      }
    });

    const downloadedFiles = await Promise.all(
      imageUrls.map(async (imageUrl) => {
        const filePath = await downloadImage(imageUrl, imagesDir);
        return filePath; // Include only successfully downloaded files
      })
    );

    // Filter out null values (failed downloads)
    const validFiles = downloadedFiles.filter(file => file !== null);

    if (validFiles.length === 0) {
      return res.status(400).json({ error: 'No valid images were downloaded.' });
    }

    // Calculate duration per image based on totalDuration and the number of valid files
    const durationPerImage = totalDuration / validFiles.length;

    const outputFilePath = path.join(storageDir, `${uuidv4()}_images_to_video.mp4`);

    // Select FFmpeg scaling and padding filter based on user-selected format
    let filter;
    if (format === 'landscape') {
      filter = "scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"; // Landscape 16:9
    } else if (format === 'portrait') {
      filter = "scale=w=1080:h=1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2"; // Portrait 9:16
    } else if (format === 'square') {
      filter = "scale=w=1080:h=1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2"; // Square 1:1
    } else {
      return res.status(400).json({ error: 'Invalid format. Please choose landscape, portrait, or square.' });
    }

    // FFmpeg command for merging images to video with calculated duration per image
    const command = `ffmpeg -framerate 1/${durationPerImage} -pattern_type glob -i '${imagesDir}/*.jpg' -vf "${filter},format=yuv420p" -c:v libx264 -r 30 -pix_fmt yuv420p ${outputFilePath}`;

    // Execute the FFmpeg command
    await execPromise(command);

    res.status(200).json({ message: 'Video created from images successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error creating video from images:', error);
    res.status(500).json({ error: 'Failed to create video from images.' });
  }
});



// Modified endpoint to add audio to video
app.post('/add-audio', async (req, res) => {
  try {
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume, backgroundVolume } = req.body;

    // Validate inputs
    if (!videoUrl || !contentAudioUrl) {
      return res.status(400).json({ error: 'Missing video URL or content audio URL.' });
    }

    // Define paths for video, content audio, background audio, and output
    const videoPath = path.join(storageDir, `${uuidv4()}_input_video.mp4`);
    const contentAudioPath = path.join(storageDir, `${uuidv4()}_content_audio.mp3`);
    const backgroundAudioPath = path.join(storageDir, `${uuidv4()}_background_audio.mp3`);
    const outputFilePath = path.join(storageDir, `${uuidv4()}_final_output.mp4`);

    // Download the video and audio files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(contentAudioUrl, contentAudioPath);
    if (backgroundAudioUrl) {
      await downloadFile(backgroundAudioUrl, backgroundAudioPath);
    }

    // Call function to add audio to video with fallback for background audio issues
    await addAudioToVideoWithFallback(videoPath, contentAudioPath, backgroundAudioPath, outputFilePath, contentVolume, backgroundVolume);

    // Clean up temporary files (optional)
    fs.unlinkSync(videoPath);
    fs.unlinkSync(contentAudioPath);
    if (fs.existsSync(backgroundAudioPath)) {
      fs.unlinkSync(backgroundAudioPath);
    }

    // Return the path to the final video
    res.status(200).json({ message: 'Audio added to video successfully', outputUrl: outputFilePath });
  } catch (error) {
    console.error('Error processing add-audio request:', error.message);
    res.status(500).json({ error: 'An error occurred while adding audio to the video.' });
  }
});




// Endpoint to get audio duration
app.post('/get-audio-duration', async (req, res) => {
  try {
    const { audioUrl } = req.body;

    // Validate audioUrl
    if (!audioUrl) {
      return res.status(400).json({ error: 'Missing audio URL.' });
    }

    // Temporary path to store the audio file
    const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);

    // Download the audio file to a temp path
    await downloadFile(audioUrl, tempAudioPath);

    // Get audio metadata using ffmpeg
    ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
      if (err) {
        console.error('Error fetching audio metadata:', err);
        return res.status(500).json({ error: 'Error fetching audio metadata.' });
      }

      // Extract duration from metadata
      const duration = metadata.format.duration;

      // Clean up the temporary audio file
      fs.unlinkSync(tempAudioPath);

      // Respond with the audio duration
      res.json({ duration });
    });
  } catch (error) {
    console.error('Error processing get-audio-duration request:', error.message);
    res.status(500).json({ error: 'Failed to retrieve audio duration.' });
  }
});



// Endpoint to download files
app.get('/download/:filename', (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(storageDir, filename);

  // Check if file exists
  if (fs.existsSync(filePath)) {
    // Set appropriate headers for file download
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});


// Function to trim video
async function trimVideo(inputPath, outputTrimmedPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime('0')
            .setDuration('3') // Set duration to 3 seconds
            .output(outputTrimmedPath)
            .on('end', () => {
                console.log(`Trimmed video saved to: ${outputTrimmedPath}`);
                resolve(outputTrimmedPath);
            })
            .on('error', (err) => {
                console.error(`Error trimming video: ${err.message}`);
                reject(err);
            })
            .run();
    });
}


// Function to merge videos
async function mergeVideos(fileListPath, outputPath) {
    return new Promise((resolve, reject) => {
        const ffmpegCommand = ffmpeg()
            .input(fileListPath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c:v libx264', '-preset fast', '-crf 23']) // Re-encoding options
            .output(outputPath)
            .on('end', () => {
                console.log(`Merged video saved to: ${outputPath}`);
                resolve();
            })
            .on('error', (err) => {
                console.error(`Error merging videos: ${err.message}`);
                reject(err);
            });

        // Log the command for debugging
        console.log(`Executing FFmpeg command for merging:`, ffmpegCommand); 
        ffmpegCommand.run();
    });
}


// Function to convert images to videos with a fallback duration
async function convertImageToVideo(imagePath, duration = 5) {
    return new Promise((resolve, reject) => {
        const cleanPath = cleanFileName(imagePath);
        const outputVideoPath = `${cleanPath.split('.')[0]}_video.mp4`;

        console.log(`Processing image: ${cleanPath}`);  // Add logging to track the exact image path

        // Check if the file exists
        if (!fs.existsSync(cleanPath)) {
            console.error(`File ${cleanPath} does not exist! Skipping...`);
            reject(new Error(`File not found: ${cleanPath}`));
            return;
        }

        const probedDuration = duration === 'N/A' ? 5 : duration;

        ffmpeg(cleanPath)
            .loop(probedDuration)
            .outputOptions('-c:v', 'libx264', '-t', probedDuration, '-pix_fmt', 'yuv420p')
            .on('end', () => {
                console.log(`Converted image ${cleanPath} to video ${outputVideoPath}`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                console.error(`Error converting ${cleanPath}: ${err.message}`);
                reject(err);
            })
            .save(outputVideoPath);
    });
}





// Function to check if the file exists
function fileExists(filePath) {
    return fs.existsSync(filePath);
}


async function probeMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                console.error(`Error probing media ${filePath}: ${err.message}`);
                resolve('N/A');  // If there's an error probing, return N/A
            } else {
                const duration = metadata.format.duration;
                resolve(duration ? parseFloat(duration) : 'N/A');
            }
        });
    });
}

// Helper function to probe video duration using FFMPEG
function probeVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration;
      resolve(duration);
    });
  });
}



// Function to create the file list for FFmpeg
async function createFileList(mediaPaths) {
    const fileListPath = path.join(storageDir, 'file_list.txt'); // Updated path to ensure it's in the correct directory
    let fileListContent = '';

    for (let mediaPath of mediaPaths) {
        const cleanPath = cleanFileName(mediaPath);
        let duration;

        try {
            duration = await probeMediaDuration(cleanPath); // Probe the duration of the media
        } catch (error) {
            console.error(`Error probing media ${cleanPath}: ${error.message}`);
            continue; // Skip this file and continue with others
        }

        if (duration === 'N/A' || duration < 1) { // If no duration, convert to video with default duration
            try {
                mediaPath = await convertImageToVideo(cleanPath, 5); // Convert to a 5-second video
            } catch (error) {
                console.error(`Skipping file ${cleanPath} due to conversion error: ${error.message}`);
                continue; // Skip this file and continue with others
            }
        }

        fileListContent += `file '${cleanPath}'\n`;
    }

    fs.writeFileSync(fileListPath, fileListContent); // Write the final file list
    console.log(`File list created at: ${fileListPath}`);
    return fileListPath;
}


// Helper function to validate URL
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}



// Helper function to get media duration
async function getMediaDuration(mediaFile) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(mediaFile, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                resolve(metadata.format.duration);
            }
        });
    });
}





async function mergeMediaSequence(mediaFiles) {
    const validMedia = [];
    let totalDuration = 0;

    for (const file of mediaFiles) {
        const url = typeof file === 'string' ? file : file.url;

        if (!url || typeof url !== 'string') {
            console.error(`Media file ${url} is not a valid string and will be removed.`);
            continue;
        }

        try {
            const media = await downloadMedia(url);
            validMedia.push(media);
            const duration = await getMediaDuration(media);
            totalDuration += duration;
        } catch (error) {
            console.error(`Error downloading media from ${url}: ${error.message}`);
            console.error(`Media file ${url} is faulty and will be removed.`);
        }
    }

    if (validMedia.length === 0) {
        throw new Error("No valid media to merge.");
    }

    // Redistribute the total duration among valid media
    const distributedDuration = totalDuration / validMedia.length;

    // Create a FFmpeg command
    const ffmpeg = require('fluent-ffmpeg');
    
    return new Promise((resolve, reject) => {
        const command = ffmpeg();

        validMedia.forEach(media => {
            command.input(media); // Add each valid media input
        });

        // Set the output options to ensure compatibility
        command
            .outputOptions('-filter_complex', 'concat=n=' + validMedia.length + ':v=1:a=1') // Ensure video and audio are concatenated properly
            .on('end', () => {
                console.log('Merging completed successfully.');
                resolve('/app/storage/processed/merged_sequence.mp4'); // Adjust the output path as needed
            })
            .on('error', (err) => {
                console.error(`Error merging media sequence: ${err.message}`);
                reject(err);
            })
            .save('/app/storage/processed/merged_sequence.mp4'); // Adjust the output path as needed
    });
}


// Endpoint handler
app.post('/merge-media-sequence', async (req, res) => {
    const { mediaUrls } = req.body;

    if (!Array.isArray(mediaUrls) || mediaUrls.length === 0) {
        return res.status(400).send('No media URLs provided.');
    }

    try {
        const mergedMediaPath = await mergeMediaSequence(mediaUrls);
        res.status(200).send(`Merged media saved at: ${mergedMediaPath}`);
    } catch (error) {
        res.status(500).send(`Error merging media sequence: ${error.message}`);
    }
});



// Endpoint to merge images and videos in sequence
app.post('/merge-media-sequence', async (req, res) => {
    try {
        const { mediaSequence } = req.body;
        if (!mediaSequence || !Array.isArray(mediaSequence)) {
            return res.status(400).json({ error: 'Invalid mediaSequence input. It must be an array of media objects.' });
        }

        const outputFilePath = path.join(storageDir, `${uuidv4()}_merged_sequence.mp4`);
        await mergeMediaSequence(mediaSequence, outputFilePath);

        res.status(200).json({ message: 'Media merged successfully', outputUrl: outputFilePath });
    } catch (error) {
        console.error('Error merging media sequence:', error);
        res.status(500).json({ error: 'Failed to merge media sequence.' });
    }
});




const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
