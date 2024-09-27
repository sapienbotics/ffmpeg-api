const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const util = require('util');
const { promisify } = require('util');


const app = express();
app.use(express.json());

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

const storageDir = path.join(__dirname, 'storage', 'processed');
const processedDir = path.join(storageDir, 'media');
const outputDir = path.join(__dirname, 'output'); // Added output directory for storing processed videos
app.use('/output', express.static(outputDir));


// Ensure processed and output directories exist
if (!fs.existsSync(processedDir)) {
    fs.mkdirSync(processedDir, { recursive: true });
}
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}


// Helper function to download files with timeout and retry logic
const downloadFile = async (url, outputPath, timeout = 10000) => {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout, // Timeout added here
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

// Helper function to retry downloading files if they fail
const downloadFileWithRetry = async (url, outputPath, retries = 3, timeout = 10000) => {
    for (let i = 0; i < retries; i++) {
        try {
            await downloadFile(url, outputPath, timeout);
            return; // Exit if successful
        } catch (error) {
            if (i < retries - 1) {
                console.log(`Retrying download... (${i + 1}/${retries})`);
            } else {
                console.error(`Failed after ${retries} attempts to download: ${url}`);
                throw error; // Throw error after all retries are exhausted
            }
        }
    }
};

// Function to normalize video resolution and codecs
async function normalizeVideo(inputPath) {
    const outputPath = inputPath.replace('.mp4', '_normalized.mp4');
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoCodec('libx264')  // Ensures video codec is H.264
            .audioCodec('aac')  // Ensures audio codec is AAC
            .outputOptions([
                '-vf', 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2',
                '-preset', 'ultrafast',  // Speed up encoding
                '-crf', '23'  // Control output quality
            ])
            .on('start', (commandLine) => {
                console.log(`Started normalizing video with command: ${commandLine}`);
            })
            .on('end', () => {
                console.log(`Video normalization completed: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(`Error normalizing video: ${err.message} for input ${inputPath}`);
                reject(err);
            })
            .save(outputPath);
    });
}



// Function to cleanup files
const cleanupFiles = async (filePaths) => {
    for (const filePath of filePaths) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up file: ${filePath}`);
            }
        } catch (err) {
            console.error(`Error cleaning up file ${filePath}: ${err.message}`);
        }
    }
};



// Helper function to remove audio from a video
async function removeAudio(videoUrl) {
    const outputFilePath = path.join(outputDir, `${path.basename(videoUrl, path.extname(videoUrl))}_no_audio.mp4`);

    return new Promise((resolve, reject) => {
        console.log(`Removing audio from video: ${videoUrl}`);
        execPromise(`ffmpeg -i ${videoUrl} -c:v copy -an "${outputFilePath}"`) // Using execPromise
            .then(() => {
                console.log(`Audio removed from video: ${outputFilePath}`);
                resolve(outputFilePath);
            })
            .catch(err => {
                console.error(`Error removing audio from ${videoUrl}: ${err.message}`);
                reject(err);
            });
    });
}



async function trimVideo(inputPath, duration) {
    const outputPath = inputPath.replace('.mp4', '_trimmed.mp4');
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(0)
            .setDuration(duration)
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log(`Started trimming video with command: ${commandLine}`);
            })
            .on('end', () => {
                console.log(`Trimmed video created: ${outputPath}`);
                resolve(outputPath);
            })
            .on('error', (err) => {
                console.error(`Error trimming video: ${err.message} for input ${inputPath}`);
                reject(err);
            })
            .run();
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
            .loop(duration)
            .outputOptions([
                '-vf', 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2',
                '-r', '30',
                '-c:v', 'libx264',
                '-preset', 'ultrafast',  // Speed up encoding
                '-crf', '22'
            ])
            .on('start', (commandLine) => {
                console.log(`Started converting image to video with command: ${commandLine}`);
            })
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

    const concatFilePath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
    const concatFileContent = validMedia.map(media => `file '${media}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatFileContent);

    console.log(`Contents of concat file: ${concatFileContent}`);

    const outputFilePath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22')
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

    // Create an array of promises for batch processing
    const processPromises = mediaSequence.map(async (media) => {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();

        if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
            console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
            const localVideoPath = path.join(outputDir, path.basename(url));
            await downloadFileWithRetry(url, localVideoPath);

            // Log video processing start
            console.log(`Downloading video from URL: ${url}`);

            const trimmedVideoPath = await trimVideo(localVideoPath, duration);
            console.log(`Trimming video completed: ${trimmedVideoPath}`);

            // Ensure resolution and codecs match before adding for merging
            const normalizedVideoPath = await normalizeVideo(trimmedVideoPath);
            videoPaths.push(normalizedVideoPath);
            console.log(`Video normalized to common resolution: ${normalizedVideoPath}`);

        } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
            console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
            try {
                const videoPath = await convertImageToVideo(url, duration);
                videoPaths.push(videoPath);
            } catch (error) {
                console.error(`Error converting image to video: ${error.message}`);
            }
        }
    });

    // Wait for all promises to resolve
    await Promise.all(processPromises);

    if (videoPaths.length > 0) {
        try {
            const mergeResult = await mergeMediaUsingFile(videoPaths);
            console.log(`Merged video created at: ${mergeResult.outputFileUrl}`);
            return mergeResult.outputFileUrl;
        } catch (error) {
            console.error(`Error merging videos: ${error.message}`);
            throw error;
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

// Helper function to check if a file exists
const fileExists = (filePath) => {
    return new Promise((resolve) => {
        fs.access(filePath, fs.constants.F_OK, (err) => {
            resolve(!err);
        });
    });
};







app.post('/merge-audio-free-videos', async (req, res) => {
    const { videoUrls } = req.body;
    const outputPath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);
    const outputFilename = path.basename(outputPath); // Extracting just the filename for the response URL

    // Validate the input
    if (!Array.isArray(videoUrls) || videoUrls.length < 2) {
        return res.status(400).json({ error: 'At least two valid video URLs are required.' });
    }

    try {
        // Download videos to temporary files
        const downloadedFiles = await Promise.all(videoUrls.map(async (obj, index) => {
            const videoUrl = obj.url;
            const tempPath = path.join(outputDir, `temp_video_${index}_${Date.now()}.mp4`);

            // Download the file using Axios
            const response = await axios({
                method: 'get',
                url: videoUrl,
                responseType: 'stream',
            });

            // Write the stream to a file
            const writer = fs.createWriteStream(tempPath);
            response.data.pipe(writer);

            // Wait for the file to finish downloading
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            return tempPath;
        }));

        // Prepare FFmpeg inputs
        const inputs = downloadedFiles.map(file => `-i "${file}"`).join(' ');
        const filterComplex = `concat=n=${downloadedFiles.length}:v=1:a=0`;
        
        // Added -pix_fmt option to specify the pixel format
        const ffmpegCommand = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -pix_fmt yuv420p -y "${outputPath}"`;

        console.log(`Running command: ${ffmpegCommand}`); // Log command for debugging

        exec(ffmpegCommand, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${stderr}`);
                return res.status(500).json({ error: 'Error merging videos', details: stderr });
            }

            console.log(`Merged video created at: ${outputPath}`);

            // Cleanup temporary files
            for (const file of downloadedFiles) {
                fs.unlinkSync(file);
            }

            // Return download link in the desired format
            const downloadUrl = `https://ffmpeg-api-production.up.railway.app/download/merged/${outputFilename}`;
            return res.status(200).json({ message: 'Videos merged successfully', output: downloadUrl });
        });
    } catch (err) {
        console.error('Error processing videos:', err);
        return res.status(500).json({ error: 'Internal server error', details: err.message });
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
    const outputFilePath = path.join(outputDir, `${uuidv4()}_final_output.mp4`); // Store final output in outputDir

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

    // Generate the final HTTPS output URL
    const outputUrl = `https://ffmpeg-api-production.up.railway.app/download/merged/${path.basename(outputFilePath)}`;

    // Return the HTTPS link to the final video
    res.status(200).json({ message: 'Audio added to video successfully', outputUrl: outputUrl });
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
