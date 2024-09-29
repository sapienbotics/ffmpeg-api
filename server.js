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
                '-preset veryfast',
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

async function convertImageToVideo(imageUrl, duration) {
    const outputFilePath = path.join(outputDir, `${Date.now()}_image.mp4`);
    const startTime = Date.now(); // Start time for the entire function

    return new Promise((resolve, reject) => {
        console.log(`Starting conversion for image: ${imageUrl}`);

        // Log timing for each ffmpeg step
        const timeLogger = (step) => {
            console.log(`${step} took ${Date.now() - startTime} ms`);
        };

        ffmpeg()
            .input(imageUrl)
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
            // Log loop duration
            .loop(duration)
            .on('codecData', () => {
                timeLogger('Looping');
            })

            // Video filter options with timing
            .outputOptions('-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1/1')
            .on('codecData', () => {
                timeLogger('Resolution and Padding');
            })

            // Frame rate and encoding settings
            .outputOptions('-r', '15')
            .outputOptions('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23')
            .outputOptions('-threads', '6')  // Use 6 threads for the process
            .on('codecData', () => {
                timeLogger('Encoding Settings');
            })

            .save(outputFilePath); // Output the video
    });
}





// Function to convert video to a standard format and resolution

async function convertVideoToStandardFormat(inputVideoPath, duration) {
    const outputVideoPath = path.join(outputDir, `${Date.now()}_converted.mp4`);
    
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(inputVideoPath)
            .outputOptions('-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1/1') // Added setsar=1/1
            .outputOptions('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23')
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

            // Convert to a common format and resolution
            const convertedVideoPath = await convertVideoToStandardFormat(localVideoPath, duration);
            
            // Trim the video after conversion
            const trimmedVideoPath = await trimVideo(convertedVideoPath, duration);
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
  const { videoUrl, contentAudioUrl, backgroundAudioUrl, contentVolume = 1, backgroundVolume = 0.5 } = req.body;

  try {
    // Generate dynamic file name for output
    const outputFilename = `output_${Date.now()}.mp4`;
    const outputFilePath = path.join(outputDir, outputFilename);

    // Download video and content audio
    const videoFilePath = await downloadFile(videoUrl, path.join(outputDir, 'video.mp4'));
    const contentAudioFilePath = await downloadFile(contentAudioUrl, path.join(outputDir, 'contentAudio.mp3'));

    let backgroundAudioFilePath;
    let backgroundAudioExists = false;

    // Attempt to download background audio if URL is provided
    if (backgroundAudioUrl) {
      backgroundAudioFilePath = await downloadBackgroundAudio(backgroundAudioUrl);
      if (backgroundAudioFilePath) {
        backgroundAudioExists = true;
      } else {
        console.error('Background audio not downloadable from the provided URL');
      }
    }

    // Prepare ffmpeg command to merge video and audio
    let ffmpegCommand = `ffmpeg -i "${videoFilePath}" -i "${contentAudioFilePath}" -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=3[a]" -map "[a]" -c:v copy -shortest "${outputFilePath}"`;

    // If background audio exists, include it in the command
    if (backgroundAudioExists) {
      ffmpegCommand = `ffmpeg -i "${videoFilePath}" -i "${contentAudioFilePath}" -i "${backgroundAudioFilePath}" -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=first:dropout_transition=3[a]" -map "[a]" -c:v copy -shortest "${outputFilePath}"`;
    }

    // Execute ffmpeg command
    try {
      await execPromise(ffmpegCommand);
    } catch (error) {
      console.error('FFmpeg error:', error.stderr);
      throw new Error('Error during FFmpeg execution.');
    }

    // Check if the output file exists
    if (!fs.existsSync(outputFilePath)) {
      throw new Error('Output file not created.');
    }

    // Return dynamic download link for the output file
    const downloadUrl = `https://ffmpeg-api-production.up.railway.app/download/merged/${outputFilename}`;

    // Send response with dynamic output URL
    res.json({
      message: "Audio added to video successfully",
      outputUrl: downloadUrl
    });

  } catch (error) {
    console.error('Error adding audio:', error.message);
    res.status(500).json({ message: 'Error adding audio to video', details: error.message });
  }
});

// Function to download background audio
async function downloadBackgroundAudio(url) {
  try {
    const tempAudioPath = path.join(outputDir, 'backgroundAudio.mp3');
    await downloadFile(url, tempAudioPath);
    return tempAudioPath;
  } catch (error) {
    console.error('Error downloading background audio:', error.message);
    return null; // Return null if downloading fails
  }
}







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
