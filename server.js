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

async function convertImageToVideo(imageUrl, duration, resolution, orientation) {
    const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);
    const startTime = Date.now(); // Start time for the entire function

    return new Promise(async (resolve, reject) => {
        console.log(`Starting conversion for image: ${imageUrl}`);

        // Log timing for each ffmpeg step
        const timeLogger = (step) => {
            console.log(`${step} took ${Date.now() - startTime} ms`);
        };

        const outputPath = './downloaded_image.jpg'; // Specify your output path for downloading
        await downloadFile(imageUrl, outputPath); // Download the image
        const dominantColor = await extractDominantColor(outputPath); // Extract the dominant color

        const [width, height] = resolution.split(':').map(Number);
        let scaleOptions;

        // Determine padding based on orientation
        if (orientation === 'portrait') {
            scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
        } else if (orientation === 'landscape') {
            scaleOptions = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
        } else if (orientation === 'square') {
            scaleOptions = `scale=${Math.min(width, height)}:${Math.min(width, height)}:force_original_aspect_ratio=decrease,pad=${Math.min(width, height)}:${Math.min(width, height)}:(ow-iw)/2:(oh-ih)/2:color=${dominantColor},setsar=1/1`;
        } else {
            reject(new Error('Invalid orientation specified.'));
            return; // Early exit on error
        }

        ffmpeg()
            .input(outputPath) // Use the downloaded image
            .on('start', () => {
                console.log('FFmpeg process started.');
            })
            .on('progress', (progress) => {
                console.log(`Processing: ${progress.frames} frames done at ${progress.currentFps} fps`);
            })
            .on('end', () => {
                timeLogger('Total Conversion');
                console.log(`Converted ${imageUrl} to video.`);
                resolve(outputFilePath);
            })
            .on('error', (err) => {
                console.error(`Error converting image to video: ${err.message}`);
                reject(err);
            })
            .loop(duration)
            .on('codecData', () => {
                timeLogger('Looping');
            })
            .outputOptions('-vf', scaleOptions)  // Use dynamic scaling based on orientation
            .on('codecData', () => {
                timeLogger('Resolution and Padding');
            })
            .outputOptions('-r', '15')
            .outputOptions('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
            .outputOptions('-threads', '6')
            .on('codecData', () => {
                timeLogger('Encoding Settings');
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




// Function to process media sequence with failure handling at each step
async function processMediaSequence(mediaSequence, orientation, resolution) {
    const videoPaths = [];
    let totalValidDuration = 0;
    let totalFailedDuration = 0;
    let validMediaCount = 0;

    // Parse resolution
    const [width, height] = resolution.split(':').map(Number);
    console.log(`Parsed resolution: width=${width}, height=${height}`);

    for (const media of mediaSequence) {
        const { url, duration } = media;
        const fileType = path.extname(url).toLowerCase();
        let failed = false;

        // Handle each media step separately to ensure failures are caught
        try {
            if (['.mp4', '.mov', '.avi', '.mkv'].includes(fileType)) {
                console.log(`Processing media - Type: video, URL: ${url}, Duration: ${duration}`);

                // Step 1: Download video
                const localVideoPath = path.join(outputDir, path.basename(url));
                try {
                    await downloadFile(url, localVideoPath);
                } catch (err) {
                    console.error(`Download failed for video: ${url} - ${err.message}`);
                    failed = true;
                }

                // Step 2: Convert video (if download successful)
                if (!failed) {
                    try {
                        const convertedVideoPath = await convertVideoToStandardFormat(localVideoPath, duration, resolution, orientation);
                        const trimmedVideoPath = await trimVideo(convertedVideoPath, duration);
                        videoPaths.push(trimmedVideoPath);
                        totalValidDuration += duration;
                        validMediaCount++;
                    } catch (err) {
                        console.error(`Conversion/Trimming failed for video: ${url} - ${err.message}`);
                        failed = true;
                    }
                }
            } else if (['.jpg', '.jpeg', '.png'].includes(fileType)) {
                console.log(`Processing media - Type: image, URL: ${url}, Duration: ${duration}`);

                // Step 1: Check MIME type (ensure it's an image)
                const response = await axios.head(url);
                const mimeType = response.headers['content-type'];

                if (!['image/jpeg', 'image/png'].includes(mimeType)) {
                    console.error(`Unsupported MIME type for image: ${url} - ${mimeType}`);
                    failed = true;
                } else {
                    // Step 2: Convert image to video
                    try {
                        const videoPath = await convertImageToVideo(url, duration, resolution, orientation);
                        videoPaths.push(videoPath);
                        totalValidDuration += duration;
                        validMediaCount++;
                    } catch (err) {
                        console.error(`Image to video conversion failed for image: ${url} - ${err.message}`);
                        failed = true;
                    }
                }
            }

            // Step 3: Handle failure
            if (failed) {
                console.log(`Media processing failed for URL: ${url}, adding ${duration}s to failed duration.`);
                totalFailedDuration += duration;
            }

        } catch (error) {
            console.error(`Unexpected error processing media (${url}): ${error.message}`);
            totalFailedDuration += duration;  // Add the media duration to failed if unexpected error occurs
        }
    }

    if (videoPaths.length > 0) {
        try {
            // Redistribute failed media duration across remaining valid media
            if (totalFailedDuration > 0 && validMediaCount > 0) {
                const additionalTimePerMedia = totalFailedDuration / validMediaCount;
                console.log(`Redistributing ${totalFailedDuration}s across ${validMediaCount} valid media.`);
                
                // Adjust the duration for each media
                for (const media of mediaSequence) {
                    // Only adjust for valid media
                    if (!videoPaths.includes(media.url)) {
                        media.duration += additionalTimePerMedia;
                        console.log(`Adjusted duration for media ${media.url}: ${media.duration}`);
                    }
                }
            }

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
            const normalizeCommand = `ffmpeg -i "${inputFile}" -c:v libx264 -pix_fmt yuv420p -r 15 -vf "scale=640:360" -c:a aac -strict experimental -y "${normalizedPath}"`;

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
    const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume = 1, backgroundVolume = 0.5 } = req.body;

    // Validate inputs
    if (!videoUrl || !contentAudioUrl) {
      return res.status(400).json({ error: 'Missing video URL or content audio URL.' });
    }

    // Define paths for video, content audio, background audio, and output
    const videoPath = path.join(storageDir, `${uuidv4()}_input_video.mp4`);
    const contentAudioPath = path.join(storageDir, `${uuidv4()}_content_audio.mp3`);
    const backgroundAudioPath = path.join(storageDir, `${uuidv4()}_background_audio.mp3`);
    const outputFilePath = path.join(outputDir, `${uuidv4()}_final_output.mp4`);

    // Download the video and audio files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(contentAudioUrl, contentAudioPath);
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

    // Prepare the FFmpeg command based on the availability of video audio and background audio
    let ffmpegCommand;
    const commonSettings = `-ar 44100 -bufsize 1000k -threads 2`;

    if (hasVideoAudio && backgroundAudioExists) {
      // Video, content, and background audio
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[0:a][content][bg]amix=inputs=3:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (hasVideoAudio) {
      // Video and content audio only
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[0:a][content]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else if (backgroundAudioExists) {
      // Content and background audio only (no audio in video)
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -i "${backgroundAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[2:a]volume=${backgroundVolume}[bg];[content][bg]amix=inputs=2:duration=longest,aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    } else {
      // Content audio only (no audio in video or background)
      ffmpegCommand = `ffmpeg -i "${videoPath}" -i "${contentAudioPath}" -filter_complex "[1:a]volume=${contentVolume}[content];[content]aresample=async=1:min_hard_comp=0.1:max_soft_comp=0.9[aout]" -map 0:v -map "[aout]" -c:v copy ${commonSettings} -shortest "${outputFilePath}"`;
    }

    // Execute the FFmpeg command
    await execPromise(ffmpegCommand);

    // Clean up temporary files
    fs.unlinkSync(videoPath);
    fs.unlinkSync(contentAudioPath);
    if (backgroundAudioExists) {
      fs.unlinkSync(backgroundAudioPath);
    }

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




// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
