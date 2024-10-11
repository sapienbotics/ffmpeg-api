const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const util = require('util');
const { promisify } = require('util');
const Vibrant = require('node-vibrant');
const sharp = require('sharp'); // Add sharp for image conversion



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
const downloadFile = async (url, outputPath, timeout = 30000) => {
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
        if (error.response && error.response.status === 403) {
            console.error(`Error 403: Forbidden access to URL ${url}`);
        } else {
            console.error(`Error downloading file from ${url}: ${error.message}`);
        }
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

// Function to download and convert image if needed
async function downloadAndConvertImage(imageUrl, outputFilePath) {
    try {
        // Step 1: Get MIME type
        const response = await axios.head(imageUrl);
        let mimeType = response.headers['content-type'];
        console.log(`Initial MIME type of the image: ${mimeType}`);

        // Step 2: Download the image
        const imageResponse = await axios({
            url: imageUrl,
            responseType: 'arraybuffer' // Get raw image data as buffer
        });

        let buffer = imageResponse.data;
        let finalOutputPath = outputFilePath;

        // Step 3: Convert if necessary or inspect the image if MIME type is unsupported
        if (mimeType === 'image/webp') {
            // Convert webp to jpg
            finalOutputPath = outputFilePath.replace('.jpg', '_converted.jpg');
            buffer = await sharp(buffer).toFormat('jpg').toBuffer();
            const { info } = await sharp(buffer).metadata();
            console.log(`Converted image format: ${info.format}`); // Should log 'jpeg'
            console.log('Converted webp image to jpg.');
        } else if (mimeType === 'application/octet-stream') {
            // Attempt to infer MIME type using sharp
            const metadata = await sharp(buffer).metadata();
            console.log(`Inferred image format using sharp: ${metadata.format}`);

            if (['jpeg', 'png'].includes(metadata.format)) {
                // Convert and proceed
                finalOutputPath = outputFilePath.replace('.jpg', `_${metadata.format}.jpg`);
                buffer = await sharp(buffer).toFormat('jpg').toBuffer();
            } else {
                throw new Error(`Unsupported inferred MIME type: ${metadata.format}`);
            }
        } else if (!/^image\/(jpeg|jpg|png)$/.test(mimeType)) {
            throw new Error(`Unsupported MIME type: ${mimeType}`);
        }

        // Step 4: Save the image
        fs.writeFileSync(finalOutputPath, buffer);
        console.log(`Image successfully written to ${finalOutputPath}`);
        return finalOutputPath;

    } catch (error) {
        console.error(`Failed to download or convert image: ${error.message}`);
        throw error;
    }
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



async function trimVideo(videoUrl, duration) {
    const outputFilePath = path.join(outputDir, `${path.basename(videoUrl, path.extname(videoUrl))}_trimmed.mp4`);

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoUrl)
            .outputOptions([
                `-t ${duration}`, 
                '-r 15', 
                '-c:v libx264', 
                '-preset fast',
                '-crf 22',
                '-vf setsar=1/1' // Ensure the SAR is set, but no scaling is applied
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



// Function to extract dominant color from an image
const extractDominantColor = async (imagePath) => {
    const palette = await Vibrant.from(imagePath).getPalette();
    return palette.Vibrant.hex; // Get the hex value of the dominant color
};

// Use this in your image-to-video processing
async function convertImageToVideo(imageUrl, duration, resolution, orientation) {
    const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);
    const startTime = Date.now(); 

    return new Promise(async (resolve, reject) => {
        console.log(`Starting conversion for image: ${imageUrl}`);

        const downloadedImagePath = path.join(outputDir, 'downloaded_image.jpg');
        
        try {
            // Step 1: Download the image (and convert if necessary)
            const finalImagePath = await downloadAndConvertImage(imageUrl, downloadedImagePath);

            // Step 2: Extract the dominant color
            const dominantColor = await extractDominantColor(finalImagePath);

            const [width, height] = resolution.split(':').map(Number);
            let scaleOptions;

            if (orientation === 'portrait') {
                scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
            } else if (orientation === 'landscape') {
                scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
            } else if (orientation === 'square') {
                scaleOptions = `scale=${Math.min(width, height)}:${Math.min(width, height)}:force_original_aspect_ratio=decrease,pad=${Math.min(width, height)}:${Math.min(width, height)}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
            } else {
                reject(new Error('Invalid orientation specified.'));
                return;
            }

            // Step 3: Convert image to video
            ffmpeg()
                .input(finalImagePath)
                .loop(duration)
                .outputOptions('-vf', scaleOptions)
                .outputOptions('-r', '15')
                .outputOptions('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
                .outputOptions('-threads', '6')
                .on('end', () => {
                    console.log(`Image converted to video.`);
                    resolve(outputFilePath);
                })
                .on('error', (err) => {
                    console.error(`Error converting image to video: ${err.message}`);
                    reject(err);
                })
                .save(outputFilePath);

        } catch (error) {
            console.error(`Image download or conversion failed: ${error.message}`);
            reject(error);
        }
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





const mergeMediaUsingFile = async (mediaArray, resolution, orientation) => {
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

    // Parse the resolution (e.g., "640:360" -> width: 640, height: 360)
    const [width, height] = resolution.split(':');

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions('-c:v', 'libx264', '-preset', 'fast', '-crf', '22')
            // Apply orientation-specific scaling and padding
            .outputOptions(`-vf`, `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1/1`)
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

async function processMediaSequence(mediaSequence, orientation, resolution) {
    let videoPaths = [];
    let totalValidDuration = 0;
    let totalFailedDuration = 0;
    let validMediaCount = 0;
    let validMedia = [];
    let adjustedDurations = mediaSequence.map(media => media.duration);
    const failedMediaUrls = new Set();

    const [width, height] = resolution.split(':').map(Number);
    console.log(`Parsed resolution: width=${width}, height=${height}`);

    async function processMedia(media, newDuration) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();

        if (failedMediaUrls.has(url)) {
            console.log(`Skipping already failed media: ${url}`);
            return true;
        }

        let failed = false;
        try {
            if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
                console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
                const localVideoPath = path.join(outputDir, path.basename(url));

                try {
                    await downloadFile(url, localVideoPath);
                } catch (err) {
                    console.error(`Download failed for video: ${url} - ${err.message}`);
                    failed = true;
                }

                if (!failed) {
                    try {
                        const convertedVideoPath = await convertVideoToStandardFormat(localVideoPath, duration, resolution, orientation);
                        const trimmedVideoPath = await trimVideo(convertedVideoPath, newDuration || duration);
                        videoPaths.push(trimmedVideoPath);
                        totalValidDuration += newDuration || duration;
                        validMediaCount++;
                    } catch (err) {
                        console.error(`Conversion/Trimming failed for video: ${url} - ${err.message}`);
                        failed = true;
                    }
                }
            } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
                console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);
                try {
                    const response = await axios.head(url);
                    const mimeType = response.headers['content-type'];

                    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
                        console.error(`Unsupported MIME type for image: ${url} - ${mimeType}`);
                        failed = true;
                    } else {
                        const videoPath = await convertImageToVideo(url, newDuration || duration, resolution, orientation);
                        videoPaths.push(videoPath);
                        totalValidDuration += newDuration || duration;
                        validMediaCount++;
                    }
                } catch (err) {
                    console.error(`Image to video conversion failed for image: ${url} - ${err.message}`);
                    failed = true;
                }
            }

            if (!failed) {
                validMedia.push(media);
            } else {
                console.log(`Media processing failed for URL: ${url}, adding ${newDuration || duration}s to failed duration.`);
                totalFailedDuration += newDuration || duration;
                failedMediaUrls.add(url);
            }
        } catch (error) {
            console.error(`Unexpected error processing media (${url}): ${error.message}`);
            totalFailedDuration += newDuration || duration;
            failedMediaUrls.add(url);
        }

        return failed;
    }

    // Initial media processing
    for (const [index, media] of mediaSequence.entries()) {
        const failed = await processMedia(media, adjustedDurations[index]);
        if (failed) {
            console.log(`Failed processing media: ${media.url}`);
        }
    }

    // Redistribution of duration
    if (validMediaCount > 0 && totalFailedDuration > 0) {
        const additionalTimePerMedia = totalFailedDuration / validMediaCount;
        console.log(`Redistributing ${totalFailedDuration}s across ${validMediaCount} valid media.`);

        validMedia.forEach((media) => {
            const originalIndex = mediaSequence.indexOf(media);
            adjustedDurations[originalIndex] += additionalTimePerMedia;
            console.log(`Adjusted duration for media ${media.url}: ${adjustedDurations[originalIndex]}`);
        });

        // Reprocessing valid media with updated durations
        const reprocessValidMedia = [...validMedia]; // Copy of valid media for reprocessing
        validMedia = []; // Clear valid media to avoid infinite loop

        videoPaths = [];
        totalValidDuration = 0;
        validMediaCount = 0;

        for (const media of reprocessValidMedia) {
            const originalIndex = mediaSequence.indexOf(media);
            const newDuration = adjustedDurations[originalIndex];
            const failed = await processMedia(media, newDuration);

            if (!failed) {
                validMediaCount++;
            } else {
                console.log(`Failed reprocessing media: ${media.url}`);
            }
        }
    }

    // Merging logic
    if (videoPaths.length > 0) {
        try {
            const mergeResult = await mergeMediaUsingFile(videoPaths, resolution, orientation);
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



// Function to convert video to a standard format and resolution
async function convertVideoToStandardFormat(inputVideoPath, duration, resolution, orientation) {
    const outputVideoPath = path.join(outputDir, `${Date.now()}_converted.mp4`);
    
    const [width, height] = resolution.split(':').map(Number);
    let scaleOptions;

    // Determine padding based on orientation
    if (orientation === 'portrait') {
        scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1/1`;
    } else if (orientation === 'landscape') {
        scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1/1`;
    } else if (orientation === 'square') {
        scaleOptions = `scale=${Math.min(width, height)}:${Math.min(width, height)}:force_original_aspect_ratio=decrease,pad=${Math.min(width, height)}:${Math.min(width, height)}:(ow-iw)/2:(oh-ih)/2,setsar=1/1`;
    } else {
        throw new Error('Invalid orientation specified.');
    }

    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputVideoPath)
            .outputOptions('-vf', scaleOptions)
            .outputOptions('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
            .on('end', () => {
                console.log(`Converted video to standard format: ${outputVideoPath}`);
                resolve(outputVideoPath);
            })
            .on('error', (err) => {
                console.error(`Error converting video: ${err.message}`);
                reject(err);
            })
            .save(outputVideoPath);
    });
}

// Function to get video info and check if an audio stream exists
const getVideoInfo = async (videoPath) => {
  try {
    const { stdout, stderr } = await execPromise(`ffmpeg -i "${videoPath}" -f null -`);
    const hasAudioStream = stderr.includes('Audio:');
    return { hasAudioStream };
  } catch (error) {
    console.error('Error fetching video info:', error.message);
    throw new Error('Could not get video info');
  }
};



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
    const { mediaSequence, orientation, resolution } = req.body;

    if (!mediaSequence || !Array.isArray(mediaSequence) || mediaSequence.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty media sequence provided.' });
    }

    if (!orientation || !resolution) {
        return res.status(400).json({ error: 'Orientation and resolution must be provided.' });
    }

    try {
        const mergedVideoUrl = await processMediaSequence(mediaSequence, orientation, resolution);
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

        // Normalize input videos to ensure they have the same format and frame rate
        const normalizedFiles = await Promise.all(downloadedFiles.map(async (inputFile) => {
            const normalizedPath = path.join(outputDir, `normalized_${path.basename(inputFile)}`);
            const normalizeCommand = `ffmpeg -i "${inputFile}" -c:v libx264 -pix_fmt yuv420p -r 15 -an -y "${normalizedPath}"`;

            await new Promise((resolve, reject) => {
                exec(normalizeCommand, (error, stdout, stderr) => {
                    if (error) {
                        console.error(`Error normalizing video: ${stderr}`);
                        return reject(new Error(`Error normalizing video: ${stderr}`));
                    }
                    resolve(normalizedPath);
                });
            });

            // Cleanup the original file
            fs.unlinkSync(inputFile);
            return normalizedPath;
        }));

        // Prepare FFmpeg inputs
        const inputs = normalizedFiles.map(file => `-i "${file}"`).join(' ');
        const filterComplex = `concat=n=${normalizedFiles.length}:v=1:a=0`;

        // Add pixel format and color range settings for PC and mobile, and include verbose logging
        const ffmpegCommand = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -pix_fmt yuv420p -color_range pc -loglevel verbose -y "${outputPath}"`;

        console.log(`Running command: ${ffmpegCommand}`); // Log command for debugging

        exec(ffmpegCommand, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${stderr}`);
                return res.status(500).json({ error: 'Error merging videos', details: stderr });
            }

            console.log(`Merged video created at: ${outputPath}`);

            // Cleanup normalized files
            for (const file of normalizedFiles) {
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

app.post('/add-audio', async (req, res) => {
  try {
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume = 1, backgroundVolume = 0.05 } = req.body;

    // Validate inputs
    if (!videoUrl) {
      return res.status(400).json({ error: 'Missing video URL.' });
    }

    // Define paths for video, content audio, background audio, and output
    const videoPath = path.join(storageDir, `${uuidv4()}_input_video.mp4`);
    const contentAudioPath = contentAudioUrl ? path.join(storageDir, `${uuidv4()}_content_audio.mp3`) : null;
    const backgroundAudioPath = backgroundAudioUrl ? path.join(storageDir, `${uuidv4()}_background_audio.mp3`) : null;
    const outputFilePath = path.join(outputDir, `${uuidv4()}_final_output.mp4`);

    // Download the video
    await downloadFile(videoUrl, videoPath);

    // Attempt to download content audio if it exists
    let contentAudioExists = false;
    if (contentAudioUrl) {
      try {
        await downloadFile(contentAudioUrl, contentAudioPath);
        contentAudioExists = true;
      } catch (error) {
        console.error('Content audio download failed:', error.message);
      }
    }

    // Attempt to download background audio if it exists
    let backgroundAudioExists = false;
    if (backgroundAudioUrl) {
      try {
        await downloadFile(backgroundAudioUrl, backgroundAudioPath);
        backgroundAudioExists = true;
      } catch (error) {
        console.error('Background audio download failed:', error.message);
      }
    }

    // Check if the video has an audio stream
    const videoInfo = await getVideoInfo(videoPath);
    const hasVideoAudio = videoInfo.hasAudioStream;

    // Prepare the FFmpeg command based on the available audio sources
    let ffmpegCommand;
    const commonSettings = `-ar 44100 -bufsize 1000k -threads 2`;

    if (hasVideoAudio && contentAudioExists && backgroundAudioExists) {
      // Video, content, and background audio
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[0:a][content][bg]amix=inputs=3:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (hasVideoAudio && contentAudioExists) {
      // Video and content audio only
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[0:a][content]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (contentAudioExists && backgroundAudioExists) {
      // Content and background audio only (no audio in video)
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[content][bg]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (contentAudioExists) {
      // Content audio only (no audio in video or background)
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[content]aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (backgroundAudioExists) {
      // Background audio only (no content or video audio)
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${backgroundVolume}[bg];[bg]aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else {
      // No audio at all, just output the video
      ffmpegCommand = `ffmpeg -i "${videoPath}" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    }

    // Execute the FFmpeg command
    await execPromise(ffmpegCommand);

    // Clean up temporary files
    fs.unlinkSync(videoPath);
    if (contentAudioExists) fs.unlinkSync(contentAudioPath);
    if (backgroundAudioExists) fs.unlinkSync(backgroundAudioPath);

    // Check if the output file exists
    if (!fs.existsSync(outputFilePath)) {
      throw new Error('Output file not created.');
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


// Endpoint to apply subtitles to a video
app.post('/apply-subtitles', async (req, res) => {
    try {
        const {
            "video-link": videoLink,
            content,
            subtitle_font: fontName = 'Mangal', // Default to Mangal
            subtitle_size: fontSize = '40', // Ensure this is a string for compatibility
            subtitle_color: subtitleColor = '#FFFFFF', // White by default
            back_color: backColor = '#000000', // Black background
            opacity = '1',  // Fully opaque by default
            subtitles_position: position = '2', // Default position (bottom center)
            include_subtitles: includeSubtitles = 'false' // Default to 'false' (string)
        } = req.body;

        // Log received input
        console.log('Received request with the following data: ', {
            videoLink,
            content,
            fontName,
            fontSize,
            subtitleColor,
            backColor,
            opacity,
            position,
            includeSubtitles
        });

        // Convert string to boolean
        const shouldIncludeSubtitles = includeSubtitles.toLowerCase() === 'true';
        console.log('Should include subtitles: ', shouldIncludeSubtitles);

        // Validate input
        if (!videoLink || !content || position === undefined) {
            if (!res.headersSent) {
                console.log('Invalid request data. Missing videoLink, content, or position.');
                return res.status(400).json({ error: "Video link, content, and subtitle position are required." });
            }
        }

        const videoId = uuidv4();
        const videoFile = path.join(outputDir, `${videoId}.mp4`);
        const subtitleFile = path.join(outputDir, `${videoId}.ass`);

        // Step 1: Download the video from the link
        const downloadPath = path.join(outputDir, `${videoId}-input.mp4`);
        console.log('Downloading video from: ', videoLink);

        const response = await axios({
            method: 'get',
            url: videoLink,
            responseType: 'stream'
        });

        const writer = fs.createWriteStream(downloadPath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log('Video downloaded successfully to: ', downloadPath);

        // Step 2: If subtitles are disabled, simply send the video as it is
        if (!shouldIncludeSubtitles) {
            const videoUrl = `${req.protocol}://${req.get('host')}/output/${videoId}.mp4`;
            if (!res.headersSent) {
                console.log('Subtitles are disabled. Sending video without subtitles.');
                return res.json({ videoUrl });
            }
        }

        // Step 3: Extract video length using FFmpeg
        let videoLengthInSeconds = 0;
        await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(downloadPath, (err, metadata) => {
                if (err) {
                    console.error('Error extracting video length:', err);
                    return reject(err);
                }
                videoLengthInSeconds = Math.ceil(metadata.format.duration);
                console.log('Video length in seconds: ', videoLengthInSeconds);
                resolve();
            });
        });

        // Step 4: Generate the ASS file for subtitles
        console.log('Generating ASS subtitle file...');
        const assContent = generateAss(content, fontName, parseInt(fontSize), subtitleColor, backColor, parseFloat(opacity), parseInt(position), videoLengthInSeconds);
        fs.writeFileSync(subtitleFile, assContent, { encoding: 'utf-8' });

        console.log('Subtitle file generated successfully at: ', subtitleFile);

        // Step 5: Apply subtitles to the video using FFmpeg
        await new Promise((resolve, reject) => {
            console.log('Applying subtitles with FFmpeg...');
            ffmpeg(downloadPath)
                .outputOptions([`-vf "subtitles='${subtitleFile}':fontsdir='${path.join(__dirname, 'fonts')}'"`])
                .save(videoFile)
                .on('start', (cmdline) => {
                    console.log('FFmpeg process started with command: ', cmdline);
                })
                .on('progress', (progress) => {
                    console.log('Processing: ', progress);
                })
                .on('end', () => {
                    console.log('FFmpeg process completed. Video with subtitles saved to: ', videoFile);
                    const videoUrl = `${req.protocol}://${req.get('host')}/output/${videoId}.mp4`;
                    if (!res.headersSent) {
                        res.json({ videoUrl });
                    }

                    // Clean up temporary files
                    fs.unlinkSync(downloadPath);
                    fs.unlinkSync(subtitleFile);
                    resolve();
                })
                .on('error', (err) => {
                    console.error('FFmpeg failed with error: ', err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: 'Failed to apply subtitles', details: err.message });
                    }
                    reject(err);
                });
        });

    } catch (error) {
        console.error('An error occurred:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'An error occurred while processing the request.', details: error.message });
        }
    }
});






function generateAss(content, fontName, fontSize, subtitleColor, backgroundColor, opacity, position, videoLengthInSeconds) {
    const assHeader = `
[Script Info]
Title: Subtitles
ScriptType: v4.00+
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,${fontName},${fontSize},${convertHexToAssColor(subtitleColor)},${convertHexToAssColorWithOpacity(backgroundColor, opacity)},1,3,0,${position},10,10,30

[Events]
Format: Layer, Start, End, Style, Text
`;

    const words = content.split(' ');
    const totalWords = words.length;
    const wordsPerSubtitle = 4;

    const adjustedDuration = Math.max(0, videoLengthInSeconds);
    const totalSubtitles = Math.ceil(totalWords / wordsPerSubtitle);
    const durationPerSubtitle = adjustedDuration / totalSubtitles;

    let startTime = 0;
    let events = '';

    for (let i = 0; i < totalSubtitles; i++) {
        const chunk = words.slice(i * wordsPerSubtitle, (i + 1) * wordsPerSubtitle).join(' ');
        const endTime = startTime + durationPerSubtitle;
        if (endTime > adjustedDuration) {
            break;
        }

        events += `Dialogue: 0,${formatTimeAss(startTime)},${formatTimeAss(endTime)},Default,${chunk}\n`;
        startTime = endTime;
    }

    return assHeader + events;
}

// Converts hex color to ASS format (&HAABBGGRR)
function convertHexToAssColor(hex) {
    const color = hex.replace('#', '');
    const r = color.slice(0, 2);
    const g = color.slice(2, 4);
    const b = color.slice(4, 6);
    return `&H00${b}${g}${r}`.toUpperCase();
}

// Converts hex color to ASS format with opacity for background (&HAABBGGRR)
function convertHexToAssColorWithOpacity(hex, opacity) {
    const alpha = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0').toUpperCase();
    const color = hex.replace('#', '');
    const r = color.slice(0, 2);
    const g = color.slice(2, 4);
    const b = color.slice(4, 6);
    return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function formatTimeAss(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds - Math.floor(seconds)) * 100);
    return `${pad(hours, 1)}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(millis, 2)}`;
}

function pad(num, size) {
    const s = "0000" + num;
    return s.substr(s.length - size);
}


module.exports = app; // Ensure you export your app




// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
