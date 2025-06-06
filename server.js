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
const cors = require('cors'); // Import CORS middleware
const os = require('os');
const { mkdirp } = require('mkdirp');
const cv = require('opencv4nodejs-prebuilt-install');
const Jimp = require('jimp');


const app = express();
app.use(express.json());

// CORS setup
app.use(cors({
    origin: 'https://ffmpeg-api-production.up.railway.app', // Replace with your actual tool URL
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Promisify exec for easier use with async/await
const execPromise = util.promisify(exec);

const sessionId = uuidv4(); // Generate unique ID per request
const storageDir = path.join(__dirname, 'storage', 'processed', sessionId);
const processedDir = path.join(storageDir, 'media');
const outputDir = path.join(__dirname, 'output', sessionId);


// Middleware to force download for /output files
app.use('/output', (req, res, next) => {
    // Check if the requested file is a video
    const videoRegex = /\.(mp4|mkv|avi|mov)$/; // Add more extensions if needed
    if (videoRegex.test(req.url)) {
        const filePath = path.join(outputDir, req.url);
        const stat = fs.statSync(filePath);

        // Ensure the file exists and is accessible
        if (stat && stat.isFile()) {
            res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.url)}"`); // Set attachment for download
            res.setHeader('Content-Type', 'video/mp4'); // Set to the appropriate MIME type
        } else {
            console.error(`File not found or inaccessible: ${filePath}`);
            return res.status(404).send('File not found');
        }
    }
    next();
}, express.static(outputDir));

// Ensure processed and output directories exist
[storageDir, processedDir, outputDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});


const downloadFile = async (url, outputPath, timeout = 30000) => {
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
            },
        });

        const totalBytes = response.headers['content-length'];
        const writer = fs.createWriteStream(outputPath);
        
        return new Promise((resolve, reject) => {
            let downloadedBytes = 0;
            response.data.pipe(writer);
            
            response.data.on('data', chunk => {
                downloadedBytes += chunk.length;
                // Optional: Log the download progress if needed
                //console.log(`Downloaded ${Math.round((downloadedBytes / totalBytes) * 100)}%`);
            });

            writer.on('finish', () => {
                if (downloadedBytes === parseInt(totalBytes)) {
                    resolve();
                } else {
                    fs.unlinkSync(outputPath); // Remove incomplete file
                    reject(new Error('File download incomplete'));
                }
            });

            writer.on('error', (err) => {
                fs.unlinkSync(outputPath);
                reject(err);
            });
        });
    } catch (error) {
        if (error.response && error.response.status === 403) {
            console.error(`Error 403: Forbidden access to URL ${url}`);
        } else {
            console.error(`Error downloading file from ${url}: ${error.message}`);
        }
        throw error;
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
        execPromise(`ffmpeg -i ${videoUrl} -c:v copy -an -threads 6 "${outputFilePath}"`) // Added -threads 6
 // Using execPromise
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
                '-r 30', 
                '-c:v libx264', 
                '-preset ultrafast',
                '-crf 23',
                '-vf setsar=1/1', // Ensure the SAR is set, but no scaling is applied
                '-threads 6' // Add threading option here
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

app.post('/convert-image-to-video', async (req, res) => {
    const { imageUrl, duration, resolution, orientation } = req.body;
    
    try {
        const outputFilePath = await convertImageToVideo(imageUrl, duration, resolution, orientation);
        res.json({ success: true, videoUrl: outputFilePath });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


async function convertImageToVideo(imageUrl, duration, resolution, orientation, source) {
    const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);
    console.log(`Starting conversion for image: ${imageUrl}, Source: ${source}`);

    return new Promise(async (resolve, reject) => {
        const downloadedImagePath = path.join(outputDir, 'downloaded_image.jpg');

        try {
            // Step 1: Download the image (and convert if necessary)
            const finalImagePath = await downloadAndConvertImage(imageUrl, downloadedImagePath);

            // Step 2: Extract the dominant color for padding
            const dominantColor = await extractDominantColor(finalImagePath);

            // Step 3: Parse the resolution (e.g., "1920:1080")
            const [width, height] = resolution.split(':').map(Number);

            // Step 4: Define possible effects
            const allEffects = [
    // Diagonal Zoom In/Out Effect
    `zoompan=z='if(lte(zoom,1.2),zoom+0.0015,zoom)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration * 30}:s=${width}x${height},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

    // Fade In and Out Effect
    `fade=in:0:30,fade=out:${duration * 30 - 30}:30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

    // Zoom In with Horizontal Right Movement
    `zoompan=z='if(gte(on,1),zoom+0.0015,zoom)':x='if(gte(on,1),x+3,x)':y='ih/2-(ih/zoom/2)':d=${duration * 30}:s=${width}x${height},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

    // Zoom In with Horizontal Left Movement
    `zoompan=z='if(gte(on,1),zoom+0.0015,zoom)':x='if(gte(on,1),x-1,x)':y='ih/2-(ih/zoom/2)':d=${duration * 30}:s=${width}x${height},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

    // Center Slow Zoom In Effect
    `zoompan=z='if(lte(zoom,1.2),zoom+0.0015,zoom)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${duration * 30}:s=${width}x${height},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,
];

const limitedEffects = [
    // Stationary Effect (Centered with padding)
   `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

    // Fade In Effect
    `fade=in:0:15,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,

// Fade Out Effect
    `fade=out:${duration * 30 - 15}:30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor}`,
];


            const effects = source === 'stock' ? limitedEffects : allEffects;

            // Step 5: Randomly select an effect
            const selectedEffect = effects[Math.floor(Math.random() * effects.length)];
            console.log(`Selected effect for image: ${selectedEffect}`); // Debug log for verification

            // Step 6: Apply the selected effect to the image and convert it to video
            ffmpeg()
                .input(finalImagePath)
                .loop(duration)
                .outputOptions('-vf', selectedEffect) // Apply selected effect
                .outputOptions('-r', '30') // Frame rate
                .outputOptions('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23') // Video codec and quality
                .outputOptions('-threads', '2') // Speed up with multiple threads
                .on('end', () => {
                    console.log('Image converted to video with effect.');
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
        let command = `ffmpeg -threads 6 -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content]" -map 0:v -map "[content]" -c:v copy -shortest -y "${outputFilePath}"`;

        if (backgroundAudioExists) {
            // Get durations of content audio and background audio
            const contentAudioDuration = await getAudioDuration(contentAudioPath);
            const backgroundAudioDuration = await getAudioDuration(backgroundAudioPath);

            if (backgroundAudioDuration < contentAudioDuration) {
                // Loop background audio if it is shorter than content audio
                command = `ffmpeg -threads 6 -i "${videoPath}" -i "${contentAudioPath}" -stream_loop -1 -i "${backgroundAudioPath}" -filter_complex \
                    "[1:a]volume=${contentVolume}[content]; [2:a]volume=${backgroundVolume}[background]; [content][background]amix=inputs=2:duration=longest[out]" \
                    -map 0:v -map "[out]" -c:v copy -shortest -y "${outputFilePath}"`;
            } else {
                // No looping needed, merge normally
                command = `ffmpeg -threads 6 -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex \
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
            .outputOptions('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23')
            .outputOptions('-threads', '2')
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


// Function to validate the video file (checking for corruption)
const validateVideoFile = async (filePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg(filePath).ffprobe((err, metadata) => {
            if (err) {
                reject(new Error('Invalid video file or corruption detected'));
            } else {
                resolve(metadata);
            }
        });
    });
};

// Main function to process the media sequence
async function processMediaSequence(mediaSequence, orientation, resolution, source) {
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
            console.log(`Starting to process media: ${url}, Type: ${fileType}, Duration: ${duration}`);
            
            if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
                console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);
                const localVideoPath = path.join(outputDir, path.basename(url));
                
                try {
                    console.log(`Downloading video from URL: ${url}`);
                    await downloadFile(url, localVideoPath);
                    console.log(`Download successful: ${localVideoPath}`);
                    
                    // Validate the downloaded video file
                    try {
                        await validateVideoFile(localVideoPath);  // Check the integrity of the downloaded video
                        console.log(`Video file is valid: ${localVideoPath}`);
                    } catch (err) {
                        console.error(`Invalid video file: ${url} - ${err.message}`);
                        failed = true;
                    }
                } catch (err) {
                    console.error(`Download failed for video: ${url} - ${err.message}`);
                    failed = true;
                }

                if (!failed) {
                    try {
                        console.log(`Starting video conversion for: ${localVideoPath}`);
                        const convertedVideoPath = await convertVideoToStandardFormat(localVideoPath, duration, resolution, orientation);
                        console.log(`Video converted successfully: ${convertedVideoPath}`);
                        
                        console.log(`Trimming video: ${convertedVideoPath}`);
                        const trimmedVideoPath = await trimVideo(convertedVideoPath, newDuration || duration);
                        console.log(`Video trimmed successfully: ${trimmedVideoPath}`);
                        
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
                    console.log(`Fetching image metadata for URL: ${url}`);
                    const response = await axios.head(url);
                    const mimeType = response.headers['content-type'];
                    console.log(`Image MIME type: ${mimeType}`);
                    
                    if (!['image/jpeg', 'image/png'].includes(mimeType)) {
                        console.error(`Unsupported MIME type for image: ${url} - ${mimeType}`);
                        failed = true;
                    } else {
                        console.log(`Converting image to video: ${url}`);
                        const videoPath = await convertImageToVideo(url, newDuration || duration, resolution, orientation, source); // Added source here
                        console.log(`Image converted to video successfully: ${videoPath}`);
                        
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
            console.log(`Merging video files: ${videoPaths.join(', ')}`);
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
    .outputOptions(
        '-c:v', 'libx264', 
        '-preset', 'ultrafast', 
        '-crf', '23',
        '-threads', '2' // Utilize 6 threads for processing
    )
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
    const { mediaSequence, orientation, resolution, source } = req.body; // Include source

    if (!mediaSequence || !Array.isArray(mediaSequence) || mediaSequence.length === 0) {
        return res.status(400).json({ error: 'Invalid or empty media sequence provided.' });
    }

    if (!orientation || !resolution) {
        return res.status(400).json({ error: 'Orientation and resolution must be provided.' });
    }

    if (!source) {
        return res.status(400).json({ error: 'Source must be provided.' });
    }

    try {
        const mergedVideoUrl = await processMediaSequence(mediaSequence, orientation, resolution, source); // Pass source
        res.json({
            message: 'Media merged successfully',
            mergedVideoUrl,
        });
    } catch (error) {
        console.error(`Error in merge-media-sequence endpoint: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});




app.post('/merge-audio-free-videos', async (req, res) => {
    const { videoUrls } = req.body;

    // Validate input
    if (!Array.isArray(videoUrls)) {
        return res.status(400).json({ error: 'videoUrls must be an array' });
    }

    // Handle single URL case immediately
    if (videoUrls.length === 1) {
        return res.status(200).json({ 
            message: 'Single video URL provided', 
            output: videoUrls[0].url 
        });
    }

    const outputPath = path.join(outputDir, `merged_output_${Date.now()}.mp4`);
    const outputFilename = path.basename(outputPath);

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
            const normalizeCommand = `ffmpeg -i "${inputFile}" -c:v libx264 -pix_fmt yuv420p -r 30 -an -threads 6 -y "${normalizedPath}"`;

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
        const ffmpegCommand = `ffmpeg ${inputs} -filter_complex "${filterComplex}" -pix_fmt yuv420p -color_range pc -threads 6 -loglevel verbose -y "${outputPath}"`;

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
    const commonSettings = `-ar 44100 -bufsize 1000k -threads 6`;

if (hasVideoAudio && contentAudioExists && backgroundAudioExists) {
  // Video, content, and background audio
  ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[0:a][content][bg]amix=inputs=3:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
} else if (hasVideoAudio && contentAudioExists) {
  // Video and content audio only
  ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[0:a][content]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
} else if (contentAudioExists && backgroundAudioExists) {
  // Content and background audio only (no audio in video)
  ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[content][bg]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
} else if (contentAudioExists) {
  // Content audio only (no audio in video or background)
  ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[content]aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
} else if (backgroundAudioExists) {
  // Background audio only (no content or video audio)
  ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${backgroundVolume}[bg];[bg]aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
} else {
  // No audio at all, just output the video
  ffmpegCommand = `ffmpeg -i "${videoPath}" -c:v copy ${commonSettings} -shortest -threads 6 "${outputFilePath}"`;
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
            audioDuration, // Audio duration in seconds
            subtitle_font: fontName = 'NotoSansDevanagari-VariableFont_wdth,wght',
            subtitle_size: fontSize = 40,
            subtitle_color: subtitleColor = '#FFFFFF',
            back_color: backColor = '#000000',
            opacity = 1,
            subtitles_position: position = 2,
            include_subtitles: includeSubtitles
        } = req.body;

        if (!videoLink) {
            console.error("Error: Video link is required.");
            return res.status(400).json({ error: "Video link is required." });
        }

        const videoId = uuidv4();
        const videoFile = path.join(outputDir, `${videoId}.mp4`);
        const downloadPath = path.join(outputDir, `${videoId}-input.mp4`);
        const sessionOutputDir = path.join(outputDir, videoId); // Define session directory

        fs.mkdirSync(sessionOutputDir, { recursive: true });

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

        if (includeSubtitles !== "true") {
            console.log("Subtitles are disabled, returning the original video.");
            fs.renameSync(downloadPath, videoFile);
            const videoUrl = `https://${req.get('host')}/output/${videoId}.mp4`;
            
            // Cleanup temporary files
            fs.rm(sessionOutputDir, { recursive: true, force: true }, (err) => {
                if (err) console.error(`Error cleaning up ${sessionOutputDir}:`, err);
                else console.log(`Cleaned up session directory: ${sessionOutputDir}`);
            });

            return res.json({ videoUrl });
        }

        if (!content || position === undefined || !audioDuration) {
            console.error("Error: Content, subtitle position, and audio duration are required for subtitles.");
            return res.status(400).json({ error: "Content, subtitle position, and audio duration are required for subtitles." });
        }

        const fontPath = path.join(__dirname, 'fonts', fontName + '.ttf');
        console.log("Font Path being used:", fontPath);

        const subtitleFile = path.join(outputDir, `${videoId}.ass`);
        const assContent = generateAss(content, fontName, fontSize, subtitleColor, backColor, opacity, position, audioDuration);

        fs.writeFileSync(subtitleFile, assContent, { encoding: 'utf-8' });

        console.log(`Running FFmpeg command to apply subtitles with subtitle file: ${subtitleFile}`);
        ffmpeg(downloadPath)
            .outputOptions([ 
                `-vf subtitles='${subtitleFile}':fontsdir='${path.join(__dirname, 'fonts')}'`,
                '-pix_fmt yuv420p',
                '-color_range pc',
                '-threads 6'
            ])
            .on('start', (cmd) => {
                console.log("FFmpeg command:", cmd);
            })
            .on('end', () => {
                const videoUrl = `https://${req.get('host')}/output/${videoId}.mp4`;
                console.log("Subtitle processing completed. Video URL:", videoUrl);

                res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
                res.json({ videoUrl });

                fs.unlinkSync(downloadPath);
                fs.unlinkSync(subtitleFile);

                // Cleanup temporary files
                fs.rm(sessionOutputDir, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`Error cleaning up ${sessionOutputDir}:`, err);
                    else console.log(`Cleaned up session directory: ${sessionOutputDir}`);
                });
            })
            .on('error', (err) => {
                console.error("FFmpeg error:", err.message);
                res.status(500).json({ error: 'Failed to apply subtitles', details: err.message });

                // Cleanup temporary files even in case of an error
                fs.rm(sessionOutputDir, { recursive: true, force: true }, (err) => {
                    if (err) console.error(`Error cleaning up ${sessionOutputDir}:`, err);
                    else console.log(`Cleaned up session directory: ${sessionOutputDir}`);
                });
            })
            .save(videoFile);

    } catch (error) {
        console.error("Processing error:", error.message);
        res.status(500).json({ error: 'An error occurred while processing the request.', details: error.message });

        // Cleanup temporary files even in case of an error
        fs.rm(sessionOutputDir, { recursive: true, force: true }, (err) => {
            if (err) console.error(`Error cleaning up ${sessionOutputDir}:`, err);
            else console.log(`Cleaned up session directory: ${sessionOutputDir}`);
        });
    }
});


// Function to generate subtitles (ASS format)
function generateAss(content, fontName, fontSize, subtitleColor, backgroundColor, opacity, position, audioDuration) {
    const assHeader = `
[Script Info]
Title: Subtitles
ScriptType: v4.00+
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, BackColour, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV
Style: Default,${fontName},${fontSize},${convertHexToAssColor(subtitleColor)},${convertHexToAssColorWithOpacity(backgroundColor, opacity)},1,3,0,${position},10,10,40

[Events]
Format: Layer, Start, End, Style, Text
`;

    const maxCharsPerSubtitle = 50; // Adjust this value based on screen size

    // Improve sentence splitting: include Hindi punctuation (।)
    const segments = content.match(/[^.?!।]+[.?!।]*/g) || [content];

    // Calculate total word count from the entire content
    const totalWords = content.split(/\s+/).filter(Boolean).length;

    // Use word count per segment instead of character length
    const segmentDurations = segments.map(segment => {
        const wordCount = segment.split(/\s+/).filter(Boolean).length;
        return (wordCount / totalWords) * audioDuration;
    });

    let startTime = 0;
    let events = '';

    segments.forEach((segment, index) => {
        const duration = segmentDurations[index];
        const words = segment.split(/\s+/);
        let chunk = '';
        let chunkStartTime = startTime;
        let remainingDuration = duration;

        for (let i = 0; i < words.length; i++) {
            // When adding a word would exceed the max characters for this subtitle chunk...
            if ((chunk + ' ' + words[i]).trim().length > maxCharsPerSubtitle) {
                // Calculate duration proportionally using word counts rather than character counts
                const currentWordCount = chunk.split(/\s+/).filter(Boolean).length;
                const totalSegmentWords = segment.split(/\s+/).filter(Boolean).length;
                let chunkDuration = remainingDuration * (currentWordCount / totalSegmentWords);
                // Ensure a minimum chunk duration for readability
                chunkDuration = Math.max(chunkDuration, 0.8);

                events += `Dialogue: 0,${formatTimeAss(chunkStartTime)},${formatTimeAss(chunkStartTime + chunkDuration)},Default,${chunk.trim()}\n`;

                chunkStartTime += chunkDuration;
                remainingDuration -= chunkDuration;
                chunk = '';
            }
            chunk += (chunk ? ' ' : '') + words[i];
        }

        // Add any remaining words as the final chunk for this segment
        if (chunk) {
            // Use remaining duration but enforce a minimum duration if needed
            let finalDuration = Math.max(remainingDuration, 0.8);
            events += `Dialogue: 0,${formatTimeAss(chunkStartTime)},${formatTimeAss(chunkStartTime + finalDuration)},Default,${chunk.trim()}\n`;
        }

        startTime += duration;
    });

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




module.exports = app; // Ensure you export your app to give

app.post('/join-audio', async (req, res) => {
    try {
        const audioSequence = req.body;

        if (!Array.isArray(audioSequence) || audioSequence.length < 1) {
            return res.status(400).json({ error: 'Invalid audioSequence: At least one audio URL is required.' });
        }

        const downloadedFiles = [];
        const outputFilePath = path.join(outputDir, `joined_audio_${uuidv4()}.mp3`);

        // Download the audio files **sequentially** to maintain order
        for (const item of audioSequence) {
            if (!item.audioUrl) {
                throw new Error('Invalid input: Each object must have an audioUrl field.');
            }

            const fileName = `${uuidv4()}.mp3`;
            const filePath = path.join(processedDir, fileName);

            await downloadFileWithRetry(item.audioUrl, filePath);
            downloadedFiles.push(filePath); // Order is now maintained
        }

        if (downloadedFiles.length === 1) {
            // If only one file, return it as is
            const singleFile = downloadedFiles[0];

            // Move the file to output directory (optional, to maintain consistency)
            fs.renameSync(singleFile, outputFilePath);

            return res.json({ message: 'Single audio file returned', outputUrl: `https://ffmpeg-api-production.up.railway.app/output/${path.basename(outputFilePath)}` });
        }

        // Normalize files to ensure uniform format
        const normalizedFiles = [];
        for (let i = 0; i < downloadedFiles.length; i++) {
            const normalizedFile = path.join(processedDir, `normalized_${i}.mp3`);
            await execPromise(`ffmpeg -i "${downloadedFiles[i]}" -acodec libmp3lame -ar 44100 -ac 2 "${normalizedFile}"`);
            normalizedFiles.push(normalizedFile); // Order is still maintained
        }

        // Create FFmpeg concat file
        const concatFilePath = path.join(outputDir, `concat_${uuidv4()}.txt`);
        const concatFileContent = normalizedFiles.map(file => `file '${file}'`).join('\n');
        fs.writeFileSync(concatFilePath, concatFileContent);

        // Execute FFmpeg command to join the audio files
        await execPromise(`ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy "${outputFilePath}"`);

        // Cleanup temporary files
        await cleanupFiles([...downloadedFiles, ...normalizedFiles, concatFilePath]);

        res.json({ message: 'Audio files joined successfully', outputUrl: `https://ffmpeg-api-production.up.railway.app/output/${path.basename(outputFilePath)}` });
    } catch (error) {
        console.error('Error joining audio files:', error);
        res.status(500).json({ error: 'Failed to join audio files. Please try again later.' });
    }
});


// DELETE endpoint to delete a file based on URL
app.delete('/delete-file', async (req, res) => {
    const { filename } = req.body;

    if (!filename) {
        return res.status(400).json({ error: 'Filename is required' });
    }

    try {
        // Ensure the filename starts with the expected base URL
        const baseUrl = 'https://ffmpeg-api-production.up.railway.app/output/';
        if (!filename.startsWith(baseUrl)) {
            return res.status(400).json({ error: 'Invalid filename URL' });
        }

        // Extract the file name from the URL
        const fileName = path.basename(filename);

        // Construct the full file path in the server's output directory
        const filePath = path.join(outputDir, fileName);

        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }

        // Delete the file
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting file:', err);
                return res.status(500).json({ error: 'An error occurred while deleting the file.' });
            }

            res.status(200).json({ message: `File ${fileName} deleted successfully.` });
        });
    } catch (err) {
        console.error('Unexpected error:', err);
        res.status(500).json({ error: 'An unexpected error occurred.' });
    }
});

app.post('/apply-custom-watermark', async (req, res) => {
    try {
        const { inputVideo, text, fontSize, fontColor, alpha, x, y } = req.body;
        if (!inputVideo) {
            return res.status(400).json({ error: "Input video path or URL is required." });
        }

        let localVideoPath = inputVideo;
        const isURL = inputVideo.startsWith('http');

        if (isURL) {
            console.log("Downloading external MP4 file...");
            const videoFileName = `input_${Date.now()}.mp4`;
            localVideoPath = path.join(processedDir, videoFileName);

            const response = await axios({
                method: 'GET',
                url: inputVideo,
                responseType: 'stream'
            });

            const writer = fs.createWriteStream(localVideoPath);
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log("Download complete:", localVideoPath);
        }

        const outputFileName = `watermarked_${Date.now()}.mp4`;
        const outputVideoPath = path.join(outputDir, outputFileName);
        const rgbaColor = `${fontColor || "white"}@${alpha || 1.0}`;

        const ffmpegCommand = `ffmpeg -i "${localVideoPath}" -vf "drawtext=text='${text || "Sample Watermark"}':fontsize=${fontSize || 30}:fontcolor=${rgbaColor}:x=${x || "(w-text_w)-10"}:y=${y || "(h-text_h)-10"}" -c:a copy "${outputVideoPath}"`;

        await execPromise(ffmpegCommand);

        // Generate public download URL
        const downloadURL = `https://ffmpeg-api-production.up.railway.app/output/${outputFileName}`;

        res.json({ message: "Watermark applied successfully", outputVideo: downloadURL });

    } catch (error) {
        console.error("Error processing watermark:", error);
        res.status(500).json({ error: `FFmpeg processing failed: ${error.message}` });
    }
});


app.post('/convert-audio', async (req, res) => {
    try {
        const { inputUrl, outputFormat } = req.body;

        if (!inputUrl || !outputFormat) {
            return res.status(400).json({ error: 'Missing inputUrl or outputFormat in request body.' });
        }

        const inputFilename = `${uuidv4()}`;
        const inputPath = path.join(storageDir, `${inputFilename}`);
        const outputPath = path.join(outputDir, `${inputFilename}.${outputFormat}`);

        // Step 1: Download the audio file
        await downloadFile(inputUrl, inputPath);

        // Step 2: Convert using FFmpeg
        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .toFormat(outputFormat)
                .on('error', (err) => reject(err))
                .on('end', () => resolve())
                .save(outputPath);
        });

        // Step 3: Return download link
        const outputUrl = `${req.protocol}://${req.get('host')}/output/${path.basename(outputPath)}`;
        return res.json({ success: true, url: outputUrl });

    } catch (error) {
        console.error('Error in /convert-audio:', error.message);
        return res.status(500).json({ error: 'Audio conversion failed.' });
    }
});




app.post('/mask-bbox', async (req, res) => {
  try {
    const { maskUrl } = req.body;
    if (!maskUrl) {
      return res.status(400).json({ error: 'maskUrl is required' });
    }

    // 1) Prepare temp folder + filename
    const tmpDir = path.join(os.tmpdir(), 'mask-processing');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const maskFile = path.join(tmpDir, `${uuidv4()}.png`);

    // 2) Download mask image
    const response = await axios({
      method: 'GET',
      url: maskUrl,
      responseType: 'arraybuffer',
    });
    await fs.promises.writeFile(maskFile, response.data);

    // 3) Load with sharp: flatten transparency to black, greyscale, raw pixels
    const { data, info } = await sharp(maskFile)
      .flatten({ background: '#000000' })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    let minX = width, maxX = -1, minY = height, maxY = -1;

    // 4) Scan for white pixels (>128)
    for (let idx = 0; idx < data.length; idx++) {
      if (data[idx] > 128) {
        const x = idx % width;
        const y = Math.floor(idx / width);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    // 5) If nothing found, fallback
    if (maxX < 0 || maxY < 0) {
      return res.json({
        width,
        height,
        x: 0,
        y: 0,
        warning: 'No mask pixels found — returning full image',
      });
    }

    // 6) Return exact bbox
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    return res.json({ width: w, height: h, x: minX, y: minY });
  } catch (err) {
    console.error('Error in /mask-bbox:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});



// ───────── Align-jewelry remains the same ─────────
app.post('/api/align-jewelry', async (req, res) => {
  try {
    const { jewelryUrl, w, h, x, y, baseW, baseH } = req.body;
    const inFile = path.join(storageDir, 'jewelry_input.png');
    const downloaded = await downloadAndConvertImage(jewelryUrl, inFile);

    const outFilename = `${uuidv4()}.png`;
    const outFile = path.join(outputDir, outFilename);

    const vf = `scale=${w}:${h},pad=${baseW}:${baseH}:${x}:${y}:color=0x00000000`;
    await execPromise(`ffmpeg -i ${downloaded} -vf "${vf}" -y ${outFile}`);

    const publicUrl = `${req.protocol}://${req.get('host')}/output/${outFilename}`;
    return res.json({ alignedUrl: publicUrl });
  } catch (err) {
    console.error('align-jewelry error:', err);
    return res.status(500).json({ error: err.message });
  }
});
// ────────────────────────────────────────────────────────


app.post('/composite-jewelry', async (req, res) => {
  try {
    const { modelUrl, jewelryUrl, maskUrl, x, y, width, height } = req.body;
    if (!modelUrl || !jewelryUrl || !maskUrl) {
      return res.status(400).json({ error: 'modelUrl, jewelryUrl & maskUrl required' });
    }

    // Download images
    const [mRes, jRes, maskRes] = await Promise.all([
      axios.get(modelUrl,   { responseType: 'arraybuffer' }),
      axios.get(jewelryUrl, { responseType: 'arraybuffer' }),
      axios.get(maskUrl,    { responseType: 'arraybuffer' }),
    ]);
    const modelBuf   = Buffer.from(mRes.data);
    const jewelryBuf = Buffer.from(jRes.data);
    const maskBuf    = Buffer.from(maskRes.data);

    // Get model dimensions
    const modelSharp = sharp(modelBuf);
    const { width: CW, height: CH } = await modelSharp.metadata();

    // Resize jewelry to mask width
    const resizedJewelry = await sharp(jewelryBuf)
      .ensureAlpha()
      .resize(width, null)
      .png()
      .toBuffer();
    const { width: RW, height: RH } = await sharp(resizedJewelry).metadata();

    // Calculate placement
    const left = Math.round(x + (width - RW) / 2);
    const top  = Math.round(y + height - RH);

    // Step 1: Generate displacement map from model image using Jimp
    const modelJimp = await Jimp.read(modelBuf);
    const displacementMap = modelJimp.clone()
      .greyscale()
      .contrast(0.5);

    // Step 2: Apply displacement to jewelry using Jimp
    const jewelryJimp = await Jimp.read(resizedJewelry);
    const displacedJewelry = jewelryJimp.displace(displacementMap, 10);
    const displacedJewelryBuf = await displacedJewelry.getBufferAsync(Jimp.MIME_PNG);

    // Step 3: Composite displaced jewelry onto full canvas using Sharp
    const jewelryCanvas = await sharp({
        create: { width: CW, height: CH, channels: 4,
                  background: { r: 0, g: 0, b: 0, alpha: 0 } }
      })
      .composite([{ input: displacedJewelryBuf, left, top }])
      .png()
      .toBuffer();

    // Apply mask
    const { data: maskRaw, info } = await sharp(maskBuf)
      .resize(CW, CH)
      .threshold(128)
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgbaMask = Buffer.alloc(info.width * info.height * 4);
    for (let i = 0; i < maskRaw.length; i++) rgbaMask[i * 4 + 3] = maskRaw[i];

    const clippedJewelry = await sharp(jewelryCanvas)
      .composite([{
        input: rgbaMask,
        raw: { width: info.width, height: info.height, channels: 4 },
        blend: 'dest-in'
      }])
      .png()
      .toBuffer();

    // Placeholder shadow and lighting logic
    const [contactShadow, ambientShadow, directionalShadow, microShadow, highlights] = 
      await Promise.all([
        sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(),
        sharp({ create: { width: CW, height: CH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
      ]);

    // Final composite
    const finalBuf = await modelSharp
      .composite([
        { input: ambientShadow, blend: 'darken', opacity: 0.8 },
        { input: contactShadow, blend: 'darken', opacity: 0.9 },
        { input: directionalShadow, blend: 'darken', opacity: 0.85 },
        { input: microShadow, blend: 'darken', opacity: 0.7 },
        { input: clippedJewelry },
        { input: highlights, blend: 'screen', opacity: 0.6 }
      ])
      .png()
      .toBuffer();

    // Save and return
    const filename = `${uuidv4()}.png`;
    const outPath = path.join(outputDir, filename);
    await fs.promises.writeFile(outPath, finalBuf);
    res.json({ compositeUrl: `${req.protocol}://${req.get('host')}/output/${filename}` });
  } catch (err) {
    console.error('composite-jewelry error:', err);
    res.status(500).json({ error: err.message });
  }
});



app.post('/enhance-shadow', async (req, res) => {
  try {
    const { compositeUrl, maskUrl, x, y, width, height } = req.body;

    if (!compositeUrl || !maskUrl || x == null || y == null || width == null || height == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1) Temp dir
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shadow-enhance-'));
    const inputImg = path.join(tmpDir, 'input.png');
    const maskImg = path.join(tmpDir, 'mask.png');
    const croppedMask = path.join(tmpDir, 'mask-crop.png');
    const shadowOnly = path.join(tmpDir, 'shadow.png');
    const finalOutput = path.join(tmpDir, 'output.png');

    // 2) Download composite and mask images
    await Promise.all([
      axios.get(compositeUrl, { responseType: 'arraybuffer' }).then(r => fs.promises.writeFile(inputImg, Buffer.from(r.data))),
      axios.get(maskUrl, { responseType: 'arraybuffer' }).then(r => fs.promises.writeFile(maskImg, Buffer.from(r.data))),
    ]);

    // 3) Crop mask to the bounding box
    await execPromise(`ffmpeg -y -i "${maskImg}" -vf "crop=${width}:${height}:${x}:${y}" "${croppedMask}"`);

    // 4) Create shadow image from cropped mask
    await execPromise(`
      ffmpeg -y -i "${croppedMask}" -filter_complex "
        [0]alphaextract,boxblur=10:2[sh];
        [sh]format=rgba,colorchannelmixer=aa=0.4[shadow]" -map "[shadow]" "${shadowOnly}"
    `);

    // 5) Overlay shadow back onto the input image at correct position
    await execPromise(`
      ffmpeg -y -i "${inputImg}" -i "${shadowOnly}" -filter_complex "
        [0][1]overlay=${x}:${y}:format=auto" "${finalOutput}"
    `);

    // 6) Validate output
    if (!fs.existsSync(finalOutput)) {
      throw new Error('Output image not created. FFmpeg likely failed.');
    }

    // 7) Save final output to public dir
    const finalName = `${uuidv4()}.png`;
    const finalPath = path.join(outputDir, finalName);
    await fs.promises.copyFile(finalOutput, finalPath);
    const publicUrl = `${req.protocol}://${req.get('host')}/output/${finalName}`;

    return res.json({ enhancedUrl: publicUrl });
  } catch (err) {
    console.error('enhance-shadow error:', err);
    return res.status(500).json({ error: err.message });
  }
});



app.post('/composite-jewelry-auto', async (req, res) => {
  try {
    const { modelUrl, jewelryUrl, maskUrl, shadowOffsetX = 5, shadowOffsetY = 5 } = req.body;
    if (!modelUrl || !jewelryUrl || !maskUrl) {
      return res.status(400).json({ error: 'modelUrl, jewelryUrl & maskUrl required' });
    }

    // 1) Download
    const [ mdlP, jwlP, mskP ] = [
      'auto_model.png','auto_jewelry.png','auto_mask.png'
    ].map(fn => path.join(storageDir, fn));
    await Promise.all([
      downloadFile(modelUrl, mdlP),
      downloadFile(jewelryUrl, jwlP),
      downloadFile(maskUrl,    mskP),
    ]);
    const [ modelBuf, jewelryBuf, maskBuf ] = await Promise.all([
      fs.promises.readFile(mdlP),
      fs.promises.readFile(jwlP),
      fs.promises.readFile(mskP),
    ]);

    // 2) Get neck box
    const { data: box } = await axios.post(
      'https://ffmpeg-api-production.up.railway.app/mask-bbox',
      { maskUrl },
      { headers: { 'Content-Type':'application/json' } }
    );
    const { x, y, width, height } = box;

    // 3) Model dims
    const modelSharp = sharp(modelBuf);
    const { width: baseW, height: baseH } = await modelSharp.metadata();

    // 4) Resize jewelry to mask width
    const resizedJewelry = await sharp(jewelryBuf)
      .ensureAlpha()
      .resize(width, null)
      .png()
      .toBuffer();
    const { width: rw, height: rh } = await sharp(resizedJewelry).metadata();

    // 5) Position under chin
    const left = Math.round(x + (width - rw)/2);
    const top  = Math.round(y +  height - rh);

    // 6) Draw jewelry on transparent canvas
    const jewelryCanvas = await sharp({
      create:{ width:baseW, height:baseH, channels:4, background:{r:0,g:0,b:0,alpha:0} }
    })
    .composite([{ input:resizedJewelry, left, top }])
    .png().toBuffer();

    // 7) Build RGBA mask for clipping
    const { data:mRaw, info } = await sharp(maskBuf)
      .resize(baseW, baseH)
      .threshold(128)
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject:true });
    const rgbaMask = Buffer.alloc(info.width*info.height*4);
    for (let i=0; i<mRaw.length; i++) {
      rgbaMask[i*4+3] = mRaw[i];
    }

    // 8) Clip the jewelry itself
    const clippedJewelry = await sharp(jewelryCanvas)
      .composite([{ input:rgbaMask, raw:{width:info.width,height:info.height,channels:4}, blend:'dest-in'}])
      .png().toBuffer();

    // ─── NEW CLEAN SHADOW ─────────────────────────────────────────────────────────

    // a) Extract jewelry alpha
    const alphaMask = await sharp(clippedJewelry)
      .extractChannel('alpha')
      .png().toBuffer();

    // b) Blur to soften
    const shadowShape = await sharp(alphaMask)
      .blur(6)
      .png().toBuffer();

    // c) Create a black layer, same size, fully transparent
    const shadowLayer = await sharp({
      create:{ width:baseW, height:baseH, channels:4, background:{r:0,g:0,b:0,alpha:1} }
    })
    // d) Use the blurred shape to punch out opacity
    .composite([{ input:shadowShape, blend:'dest-in' }])
    .png().toBuffer();

    // e) Offset that shadow
    const clippedShadow = await sharp({
      create:{ width:baseW, height:baseH, channels:4, background:{r:0,g:0,b:0,alpha:0} }
    })
    .composite([{
      input:shadowLayer,
      left: left + shadowOffsetX,
      top:  top  + shadowOffsetY,
      blend:'over'
    }])
    // f) finally clip by your mask
    .composite([{ input:rgbaMask, raw:{width:info.width,height:info.height,channels:4}, blend:'dest-in'}])
    .png().toBuffer();

    // ────────────────────────────────────────────────────────────────────────────────

    // 9) Composite onto model: shadow → jewelry
    const finalBuf = await modelSharp
      .composite([
        { input:clippedShadow },
        { input:clippedJewelry }
      ])
      .png().toBuffer();

    // 10) Save & return
    const outName = `${uuidv4()}.png`;
    const outPath = path.join(outputDir, outName);
    await fs.promises.writeFile(outPath, finalBuf);
    res.json({ compositeUrl:`${req.protocol}://${req.get('host')}/output/${outName}`});
  }
  catch(err) {
    console.error('auto composite error:', err);
    res.status(500).json({ error:err.message });
  }
});




// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
