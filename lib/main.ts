import { argv } from 'process';
import * as fs from 'fs';
import type { UsbbootDevice } from './';
import { UsbbootScanner } from './';

const usbBootExtraFolder = argv.length > 2 ? isValidPath(argv[2]) : undefined;

function isValidPath(path: string) {
	if (fs.existsSync(path)) {
		return path;
	} else {
		throw new Error(
			'Invalid path provided as argument. Please provide a valid path if you want to use alternative boot assets.',
		);
	}
}

const main = () => {
	const scanner = new UsbbootScanner(usbBootExtraFolder);
	scanner.on('attach', (usbbootDevice: UsbbootDevice) => {
		console.log('device attached', usbbootDevice.portId);
		usbbootDevice.on('progress', (progress: number) => {
			console.log('progress', usbbootDevice.portId, progress, '%');
			if (progress === 100) {
				console.log('device', usbbootDevice.portId, 'is ready');
			}
		});
	});
	scanner.on('detach', (usbbootDevice: UsbbootDevice) => {
		usbbootDevice.removeAllListeners();
		console.log('device', usbbootDevice.portId, 'detached');
	});
	console.log('Waiting for BCM2835/6/7');
	scanner.start();
};

main();
