/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import fs from "fs";
import nodePath from "path";
import { ReplayArgs, ReplayTool } from "@fluid-internal/replay-tool";
import { Deferred } from "@fluidframework/common-utils";
import { pkgVersion } from "./packageVersion";

// Determine relative file locations
function getFileLocations(): [string, string] {
    // Correct if executing from working directory of package root
    const origTestCollateralPath = "content/snapshotTestContent";
    let testCollateralPath = origTestCollateralPath;
    let workerPath = "./dist/replayWorker.js";
    if (fs.existsSync(testCollateralPath)) {
        assert(fs.existsSync(workerPath), `Cannot find worker js file: ${workerPath}`);
        return [testCollateralPath, workerPath];
    }
    // Relative to this generated js file being executed
    testCollateralPath = nodePath.join(__dirname, "..", testCollateralPath);
    workerPath = nodePath.join(__dirname, "..", workerPath);
    assert(fs.existsSync(testCollateralPath), `Cannot find test collateral path: ${origTestCollateralPath}`);
    assert(fs.existsSync(workerPath), `Cannot find worker js file: ${workerPath}`);
    return [testCollateralPath, workerPath];
}
const [fileLocation, workerLocation] = getFileLocations();

const numberOfThreads = 4;

export enum Mode {
    Write,   // Write out files
    Compare, // Compare to files stored on disk
    Stress,  // Do stress testing without writing or comparing out files.
    Validate,
}

export interface IWorkerArgs {
    folder: string;
    mode: Mode;
    snapFreq: number;
    initializeFromSnapshotsDir?: string;
}

class ConcurrencyLimiter {
    private readonly promises: Promise<void>[] = [];
    private deferred: Deferred<void> | undefined;

    constructor(private limit: number) { }

    async addWork(worker: () => Promise<void>) {
        this.limit--;
        if (this.limit < 0) {
            assert(this.deferred === undefined);
            this.deferred = new Deferred<void>();
            await this.deferred.promise;
            assert(this.deferred === undefined);
            assert(this.limit >= 0);
        }

        const p = worker().then(() => {
            this.limit++;
            if (this.deferred) {
                assert(this.limit === 0);
                this.deferred.resolve();
                this.deferred = undefined;
            }
        });
        this.promises.push(p);
    }

    async waitAll() {
        return Promise.all(this.promises);
    }
}

export async function processOneFile(args: IWorkerArgs) {
    const replayArgs = new ReplayArgs();

    replayArgs.verbose = false;
    replayArgs.inDirName = args.folder;
    // The output snapshots to compare against are under "current_snapshots" sub-directory.
    replayArgs.outDirName = `${args.folder}/current_snapshots`;
    replayArgs.snapFreq = args.snapFreq;

    replayArgs.write = args.mode === Mode.Write;
    replayArgs.compare = args.mode === Mode.Compare;
    // Make it easier to see problems in stress tests
    replayArgs.expandFiles = args.mode === Mode.Stress;
    replayArgs.initializeFromSnapshotsDir = args.initializeFromSnapshotsDir;

    // Worker threads does not listen to unhandled promise rejections. So set a listener and
    // throw error so that worker thread could pass the message to parent thread.
    const listener = (error) => {
        process.removeListener("unhandledRejection", listener);
        console.error(`unhandledRejection\n ${JSON.stringify(args)}\n ${error}`);
        throw error;
    };
    process.on("unhandledRejection", listener);

    // This will speed up test duration by ~17%, at the expense of losing a bit on coverage.
    // replayArgs.overlappingContainers = 1;

    try {
        const errors = await new ReplayTool(replayArgs).Go();
        if (errors.length !== 0) {
            throw new Error(`Errors\n ${errors.join("\n")}`);
        }
    } catch (error) {
        console.error(`Unhandled Error processing \n ${JSON.stringify(args)}\n ${error}`);
        throw error;
    }
}

export async function processContent(mode: Mode, concurrently = true) {
    const limiter = new ConcurrencyLimiter(numberOfThreads);

    for (const node of fs.readdirSync(fileLocation, { withFileTypes: true })) {
        if (!node.isDirectory()) {
            continue;
        }
        const folder = `${fileLocation}/${node.name}`;
        const messages = `${folder}/messages.json`;
        if (!fs.existsSync(messages)) {
            console.error(`Can't locate ${messages}`);
            continue;
        }

        // Clean up any failed snapshots that might have been written out in previous test run.
        cleanFailedSnapshots(folder);

        // SnapFreq is the most interesting options to tweak
        // On one hand we want to generate snapshots often, ideally every 50 ops
        // This allows us to exercise more cases and increases chances of finding bugs.
        // At the same time that generates more files in repository, and adds to the size of it
        // Thus using two passes:
        // 1) Stress test - testing eventual consistency only
        // 2) Testing backward compat - only testing snapshots at every 1000 ops
        const snapFreq = mode === Mode.Stress ? 50 : 1000;
        const data: IWorkerArgs = {
            folder,
            mode,
            snapFreq,
        };

        switch (mode) {
            case Mode.Validate:
                await processNodeForValidate(data, concurrently, limiter);
                break;
            case Mode.Write:
                await processNodeForWrite(data, concurrently, limiter);
                break;
            default:
                await processNode(data, concurrently, limiter);
        }
    }

    return limiter.waitAll();
}

/**
 * In Validate mode, we need to validate that we can load documents with snapshots in old versions. We have snapshots
 * from multiple old versions, process snapshot from each of these versions.
 */
async function processNodeForValidate(
    data: IWorkerArgs,
    concurrently: boolean,
    limiter: ConcurrencyLimiter,
) {
    // The snapshots in older format are in "src_snapshots" folder.
    const srcSnapshotsFolder = `${data.folder}/src_snapshots`;
    if (!fs.existsSync(srcSnapshotsFolder)) {
        return;
    }

    // Each sub-directory under "src_snapshots" folder contain snapshots from a particular version. Process each one
    // of these folders.
    for (const node of fs.readdirSync(srcSnapshotsFolder, { withFileTypes: true })) {
        if (!node.isDirectory()) {
            continue;
        }

        data.initializeFromSnapshotsDir = `${srcSnapshotsFolder}/${node.name}`;
        await processNode(data, concurrently, limiter);
    }
}

/**
 * In Write mode, the snapshot format has changed and we need to update the reference snapshots with the newer version.
 * We need to do the following:
 * - Move the current snapshots to a new sub-folder in the older snapshots folder.
 * - Update the current snapshots to the newer version.
 * - Update the package version of the current snapshots.
 */
async function processNodeForWrite(
    data: IWorkerArgs,
    concurrently: boolean,
    limiter: ConcurrencyLimiter,
) {
    const currentSnapshotsDir = `${data.folder}/current_snapshots`;
    assert(fs.existsSync(currentSnapshotsDir), `Directory ${currentSnapshotsDir} does not exist!`);

    const versionFileName = `${currentSnapshotsDir}/snapshotVersion.json`;
    assert(fs.existsSync(versionFileName), `Version file ${versionFileName} does not exist`);

    // Get the version of the current snapshots. This becomes the the folder name under the "src_snapshtos" folder
    // where these snapshots will be moved.
    const versionContent = JSON.parse(fs.readFileSync(`${versionFileName}`, "utf-8"));
    const version = versionContent.snapshotVersion;

    // Create the folder where the current snapshots will be moved. If this folder already exists, we will update
    // the snapshots in that folder because we only need one set of snapshots for each version.
    const newSrcDir = `${data.folder}/src_snapshots/${version}`;
    fs.mkdirSync(newSrcDir, { recursive: true });

    for (const subNode of fs.readdirSync(currentSnapshotsDir, { withFileTypes: true })) {
        assert(!subNode.isDirectory());
        fs.copyFileSync(`${currentSnapshotsDir}/${subNode.name}`, `${newSrcDir}/${subNode.name}`);
    }

    // Process the current folder which will update the current snapshots as per the changes.
    await processNode(data, concurrently, limiter);

    // Update the version of the current snapshots to the latest version.
    fs.writeFileSync(versionFileName, JSON.stringify({ snapshotVersion: pkgVersion }), { encoding: "utf-8" });
}

/**
 * Process one folder from the reference snapshots. It creates a worker thread and assigns the processing work to
 * the threads. If concurrently if false, directly processes the snapshots.
 */
async function processNode(
    data: IWorkerArgs,
    concurrently: boolean,
    limiter: ConcurrencyLimiter,
) {
    // "worker_threads" does not resolve without --experimental-worker flag on command line
    let threads: typeof import("worker_threads");
    try {
        threads = await import("worker_threads");
        threads.Worker.EventEmitter.defaultMaxListeners = 20;
    } catch (err) {
    }

    if (!concurrently || !threads) {
        await processOneFile(data);
        return;
    }

    await (async (workerData: IWorkerArgs) => limiter.addWork(async () => new Promise((resolve, reject) => {
        const worker = new threads.Worker(workerLocation, { workerData });

        worker.on("message", (error: string) => {
            if (workerData.mode === Mode.Compare) {
                // eslint-disable-next-line max-len
                const extra = "If you changed snapshot representation and validated new format is backward compatible, you can run `npm run test:generate` to regenerate baseline snapshots";
                reject(new Error(`${error}\n${extra}`));
            } else {
                reject(new Error(error));
            }
        });

        worker.on("error", (error) => {
            reject(error);
        });

        worker.on("exit", (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
            resolve();
        });
    })))(data);
}

/**
 * Cleans failed snapshots from previous test runs, if any. When the test fails in Stress mode, it writes out the
 * failed snapshots to "FailedSnapshots" directory for debugging purposes. Clean those snapshots to remove extra
 * clutter.
 */
function cleanFailedSnapshots(dir: string) {
    const currentSnapshotsDir = `${dir}/current_snapshots`;
    if (!fs.existsSync(currentSnapshotsDir)) {
        return;
    }

    const failedSnapshotsDir = `${currentSnapshotsDir}/FailedSnapshots`;
    if (!fs.existsSync(failedSnapshotsDir)) {
        return;
    }

    for (const node of fs.readdirSync(failedSnapshotsDir, { withFileTypes: true })) {
        if (node.isDirectory()) {
            continue;
        }
        fs.unlinkSync(`${failedSnapshotsDir}/${node.name}`);
    }

    fs.rmdirSync(failedSnapshotsDir);
}
