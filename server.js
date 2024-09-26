const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

const app = express();
app.use(express.json());

const storageDir = path.join(__dirname, 'storage', 'processed');
const processedDir = path.join(storageDir, 'media');
const outputDir = path.join(__dirname, 'output'); // Added output directory for storing processed videos

// Ensure processed and output directories exist
if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}


// Helper function to download files
const downloadFile = async (url, outputPath) => {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
        });

        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(outputPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                fs.unlinkSync(outputPath); // Remove the file if there was an error
                reject(err);
            });
        });
    } catch (error) {
        console.error(`Error downloading file from ${url}:`, error.message);
        throw error; // Re-throw error for handling in the calling function
    }
};



// Helper function to remove audio from a video
async function removeAudio(videoUrl) {
    const outputFilePath = path.join(outputDir, `${path.basename(videoUrl, path.extname(videoUrl))}_no_audio.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoUrl)
            .noAudio() // Removes audio track
            .on('end', () => {
                console.log(`Audio removed from video: ${outputFilePath}`);
                resolve(outputFilePath);
            })
            .on('error', (err) => {
                console.error(`Error removing audio: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
}


async function trimVideo(videoUrl, duration) {
    const outputFilePath = path.join(outputDir, `${path.basename(videoUrl, path.extname(videoUrl))}_trimmed.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoUrl)
            .outputOptions([
                `-t ${duration}`, // Trim to the specified duration
                '-vf scale=960:540',  // Scale to 960x540 resolution
                '-r 30',  // Set frame rate to 30 fps
                '-c:v libx264',  // Re-encode to H.264
                '-preset veryfast',
                '-crf 22'
            ])
            .on('end', () => {
                console.log(`Trimmed video created: ${outputFilePath}`);
                resolve(outputFilePath);
            })
            .on('error', (err) => {
                console.error(`Error trimming video: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
}



// Helper function to create file_list.txt for FFmpeg
const createFileList = (mediaSequence, outputDir) => {
    const fileListContent = mediaSequence.map(media => {
        const filePath = path.join(outputDir, `trimmed_${path.basename(media.url)}`);
        return `file '${filePath}'`;
    }).join('\n');

    const fileListPath = path.join(outputDir, 'file_list.txt');
    fs.writeFileSync(fileListPath, fileListContent);

    return fileListPath;
};

async function convertImageToVideo(imageUrl, duration) {
    const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);
    
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(imageUrl)
            .loop(duration)  // Set the duration of the image video
            .outputOptions('-vf', 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2')
            .outputOptions('-r', '30')  // Set frame rate to 30 fps
            .outputOptions('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22')  // Re-encode using H.264
            .on('end', () => {
                console.log(`Converted ${imageUrl} to video.`);
                resolve(outputFilePath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
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




const mergeMediaUsingFile = async (mediaArray) => {
    const validMedia = mediaArray.filter(media => media && media.endsWith('.mp4'));

    if (validMedia.length === 0) {
        throw new Error('No valid media to merge.');
    }

    // Create a concat file
    const concatFilePath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
    const concatFileContent = validMedia.map(media => `file '${media}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatFileContent);

    console.log(`Contents of concat file: ${concatFileContent}`);

    const outputFilePath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22') // Re-encode video to ensure compatibility
            .on('end', () => {
                console.log('Merging finished.');
                resolve({
                    status: 'success',
                    outputFileUrl: `https://ffmpeg-api-production.up.railway.app/download/merged/${path.basename(outputFilePath)}`,
                });
            })
            .on('error', (err) => {
                console.error(`Error merging media: ${err.message}`);
                reject(err);
            })
            .save(outputFilePath);
    });
};



// Function to process media sequence
async function processMediaSequence(mediaSequence) {
    const videoPaths = [];

    for (const media of mediaSequence) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();

        if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
            console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
            // Download video file locally before adding to the paths
            const localVideoPath = path.join(outputDir, path.basename(url)); // Local file path
            await downloadFile(url, localVideoPath); // Download the video

            // Trim the video to the specified duration
            const trimmedVideoPath = await trimVideo(localVideoPath, duration);
            videoPaths.push(trimmedVideoPath); // Add trimmed video path to paths
        } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
            console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
            try {
                const videoPath = await convertImageToVideo(url, duration);
                videoPaths.push(videoPath); // Add the converted video path to paths
            } catch (error) {
                console.error(`Error converting image to video: ${error.message}`);
                continue; // Skip to next media item
            }
        }
    }

    if (videoPaths.length > 0) {
        try {
            const mergeResult = await mergeMediaUsingFile(videoPaths);
            console.log(`Merged video created at: ${mergeResult.outputFileUrl}`);
            return mergeResult.outputFileUrl; // Return the merged video URL
        } catch (error) {
            console.error(`Error merging videos: ${error.message}`);
            throw error; // Rethrow error for the endpoint to catch
        }
    } else {
        console.error('No valid media found for merging.');
        throw new Error('No valid media found for merging.');
    }
}




// Function to determine media type based on URL extension
const getMediaType = (url) => {
    const extension = path.extname(url).toLowerCase();
    if (['.jpg', '.jpeg', '.png'].includes(extension)) {
        return 'image';
    } else if (['.mp4'].includes(extension)) {
        return 'video';
    }
    return null; // Unknown type
};

// Helper function to generate a unique output path for image-to-video conversion
function generateOutputPath(url) {
    const baseName = path.basename(url, path.extname(url));
    const outputPath = path.join(outputDir, `${baseName}_${Date.now()}.mp4`); // Unique filename
    return outputPath;
}

app.post('/merge-media-sequence', async (req, res) => {
    const { mediaSequence } = req.body;

    if (!mediaSequence || !Array.isArray(mediaSequence) || mediaSequence.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty media sequence provided.' });
    }

    try {
        const mergedVideoUrl = await processMediaSequence(mediaSequence);
        res.json({
            message: 'Media merged successfully',
            mergedVideoUrl,  // Include the merged video URL in the response
        });
    } catch (error) {
        console.error(`Error in merge-media-sequence endpoint: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.post('/merge-audio-free-videos', async (req, res) => {
    const { videoUrls } = req.body;

    // Validate input
    if (!videoUrls || !Array.isArray(videoUrls) || videoUrls.length === 0 || 
        !videoUrls.every(video => video.url)) { // Check if each video object has a url key
        return res.status(400).json({ error: 'Invalid or empty video URLs provided.' });
    }

    try {
        // Step 1: Remove audio from each video
        const audioFreeVideos = await Promise.all(videoUrls.map(video => removeAudio(video.url)));

        // Step 2: Merge the audio-free videos into one final video
        const mergeResult = await mergeMediaUsingFile(audioFreeVideos);

        // Respond with the direct downloadable link
        res.json({
            message: 'Videos merged successfully without audio.',
            mergedVideoUrl: `https://ffmpeg-api-production.up.railway.app/download/merged/${path.basename(mergeResult.outputFileUrl)}`, // Direct download link
        });
    } catch (error) {
        console.error(`Error in merge-audio-free-videos endpoint: ${error.message}`);
        res.status(500).json({ error: 'An error occurred while merging videos.' });
    }
});








// Endpoint to get audio duration
app.post('/get-audio-duration', async (req, res) => {
  try {
    const { audioUrl } = req.body;

    if (!audioUrl) {
      return res.status(400).json({ error: 'Missing audio URL.' });
    }

    const tempAudioPath = path.join(storageDir, `${uuidv4()}_audio.mp3`);

    await downloadFile(audioUrl, tempAudioPath);

    ffmpeg.ffprobe(tempAudioPath, (err, metadata) => {
      if (err) {
        console.error('Error fetching audio metadata:', err);
        return res.status(500).json({ error: 'Error processing audio file.' });
      }

      const duration = metadata.format.duration;
      res.json({ duration });
    });
  } catch (error) {
    console.error('Error fetching audio duration:', error);
    res.status(500).json({ error: 'Error processing the request.' });
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


// Download endpoint for processed media
app.get('/download/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(processedDir, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) {
                console.error(`Error downloading file: ${fileName}`, err);
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});

// Download endpoint for merged media
app.get('/download/merged/:filename', (req, res) => {
    const fileName = req.params.filename;
    const filePath = path.join(outputDir, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath, (err) => {
            if (err) {
                console.error(`Error downloading file: ${fileName}`, err);
                res.status(500).send('Error downloading file');
            }
        });
    } else {
        res.status(404).send('File not found');
    }
});




// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
