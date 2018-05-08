import { UsbbootDevice, UsbbootScanner } from './';

const main = () => {
	const scanner = new UsbbootScanner();
	scanner.on('error', (error) => {
		console.log('Error:', error);
	});
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
