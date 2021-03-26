/*
 * This work is heavily based on https://github.com/raspberrypi/usbboot
 * Copyright 2016 Raspberry Pi Foundation
 */

// tslint:disable:no-bitwise

import * as usb from '@balena.io/usb';
import * as _debug from 'debug';
import { EventEmitter } from 'events';
import { readFile as readFile_ } from 'fs';
import * as Path from 'path';
import { promisify } from 'util';

async function delay(ms: number) {
	await new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function fromCallback<T>(
	fn: (callback: (error?: Error | null, result?: T) => void) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		fn((error: Error | null, result: T) => {
			if (error == null) {
				resolve(result);
			} else {
				reject(error);
			}
		});
	});
}

const readFile = promisify(readFile_);

const debug = _debug('node-raspberrypi-usbboot');

const POLLING_INTERVAL_MS = 2000;

const TRANSFER_BLOCK_SIZE = 1024 ** 2;

// The equivalent of a NULL buffer, given that node-usb complains
// if the data argument is not an instance of Buffer
const NULL_BUFFER = Buffer.alloc(0);

/**
 * @summary The size of the boot message bootcode length section
 */
const BOOT_MESSAGE_BOOTCODE_LENGTH_SIZE = 4;

/**
 * @summary The offset of the boot message bootcode length section
 */
const BOOT_MESSAGE_BOOTCODE_LENGTH_OFFSET = 0;

/**
 * @summary The size of the boot message signature section
 */
const BOOT_MESSAGE_SIGNATURE_SIZE = 20;

/**
 * @summary The offset of the file message command section
 */
const FILE_MESSAGE_COMMAND_OFFSET = 0;

/**
 * @summary The size of the file message command section
 */
const FILE_MESSAGE_COMMAND_SIZE = 4;

/**
 * @summary The offset of the file message file name section
 */
const FILE_MESSAGE_FILE_NAME_OFFSET = FILE_MESSAGE_COMMAND_SIZE;

/**
 * @summary The size of the file message file name section
 */
const FILE_MESSAGE_FILE_NAME_SIZE = 256;

/**
 * @summary The GET_STATUS usb control transfer request code
 * @description
 * See http://www.jungo.com/st/support/documentation/windriver/811/wdusb_man_mhtml/node55.html#usb_standard_dev_req_codes
 */
const USB_REQUEST_CODE_GET_STATUS = 0;

/**
 * @summary The maximum buffer length of a usbboot message
 */
const USBBOOT_MESSAGE_MAX_BUFFER_LENGTH = 0xffff;

/**
 * @summary The amount of bits to shift to the right on a control transfer index
 */
const CONTROL_TRANSFER_INDEX_RIGHT_BIT_SHIFT = 16;

/**
 * @summary The size of the usbboot file message
 */
const FILE_MESSAGE_SIZE =
	FILE_MESSAGE_COMMAND_SIZE + FILE_MESSAGE_FILE_NAME_SIZE;

/**
 * @summary The usbboot return code that represents success
 */
const RETURN_CODE_SUCCESS = 0;

/**
 * @summary The buffer length of the return code message
 */
const RETURN_CODE_LENGTH = 4;
/**
 * @summary The timeout for USB control transfers, in milliseconds
 */
const USB_CONTROL_TRANSFER_TIMEOUT_MS = 10000;
/**
 * @summary The timeout for USB bulk transfers, in milliseconds
 */
const USB_BULK_TRANSFER_TIMEOUT_MS = 10000;

const USB_ENDPOINT_INTERFACES_SOC_BCM2835 = 1;
const USB_VENDOR_ID_BROADCOM_CORPORATION = 0x0a5c;
const USB_PRODUCT_ID_BCM2708_BOOT = 0x2763;
const USB_PRODUCT_ID_BCM2710_BOOT = 0x2764;
const USB_PRODUCT_ID_BCM2711_BOOT = 0x2711;
const USB_PRODUCT_ID_BCM2711_MASS_STORAGE = 1;

// When the pi reboots in mass storage mode, it has this product id
const USB_VENDOR_ID_NETCHIP_TECHNOLOGY = 0x0525;
const USB_PRODUCT_ID_POCKETBOOK_PRO_903 = 0xa4a5;

// Delay in ms after which we consider that the device was unplugged (not resetted)
const DEVICE_UNPLUG_TIMEOUT = 5000;

// Delay (in ms) to wait when epRead throws an error
const READ_ERROR_DELAY = 100;

enum FileMessageCommand {
	GetFileSize,
	ReadFile,
	Done,
}

const getCommand = (fileMessageBuffer: Buffer): FileMessageCommand => {
	const command = fileMessageBuffer.readInt32LE(FILE_MESSAGE_COMMAND_OFFSET);
	if (!(command in FileMessageCommand)) {
		throw new Error(`Invalid file message command code: ${command}`);
	}
	return command;
};

const getFilename = (fileMessageBuffer: Buffer): string => {
	// The parsed string will likely contain tons of trailing
	// null bytes that we should get rid of for convenience
	let end = fileMessageBuffer.indexOf(0, FILE_MESSAGE_FILE_NAME_OFFSET);
	if (end === -1) {
		end = fileMessageBuffer.length;
	}
	return fileMessageBuffer
		.slice(FILE_MESSAGE_FILE_NAME_OFFSET, end)
		.toString('ascii');
};

/**
 * @summary Parse a file message buffer from a device
 */
const parseFileMessageBuffer = (
	fileMessageBuffer: Buffer,
): { command: FileMessageCommand; filename: string } => {
	let command = getCommand(fileMessageBuffer);
	const filename = getFilename(fileMessageBuffer);
	// A blank file name can also mean "done"
	if (filename === '') {
		command = FileMessageCommand.Done;
	}
	return { command, filename };
};

/**
 * @summary Perform a USB control transfer
 * @description
 * See http://libusb.sourceforge.net/api-1.0/group__syncio.html
 */
const performControlTransfer = async (
	device: usb.Device,
	bmRequestType: number,
	bRequest: number,
	wValue: number,
	wIndex: number,
	dataOrLength: Buffer | number,
) => {
	const previousTimeout = device.timeout;
	device.timeout = USB_CONTROL_TRANSFER_TIMEOUT_MS;
	const result = await fromCallback(
		(callback: (error?: Error | null, data?: Buffer) => void) => {
			device.controlTransfer(
				bmRequestType,
				bRequest,
				wValue,
				wIndex,
				dataOrLength,
				callback,
			);
		},
	);
	device.timeout = previousTimeout;
	return result;
};

export const isUsbBootCapableUSBDevice = (
	idVendor: number,
	idProduct: number,
): boolean => {
	return (
		idVendor === USB_VENDOR_ID_BROADCOM_CORPORATION &&
		(idProduct === USB_PRODUCT_ID_BCM2708_BOOT ||
			idProduct === USB_PRODUCT_ID_BCM2710_BOOT ||
			idProduct === USB_PRODUCT_ID_BCM2711_BOOT)
	);
};

const isUsbBootCapableUSBDevice$ = (device: usb.Device): boolean => {
	return isUsbBootCapableUSBDevice(
		device.deviceDescriptor.idVendor,
		device.deviceDescriptor.idProduct,
	);
};

const isRaspberryPiInMassStorageMode = (device: usb.Device): boolean => {
	return (
		device.deviceDescriptor.idVendor === USB_VENDOR_ID_NETCHIP_TECHNOLOGY &&
		device.deviceDescriptor.idProduct === USB_PRODUCT_ID_POCKETBOOK_PRO_903
	);
};

const isComputeModule4InMassStorageMode = (device: usb.Device): boolean => {
	return (
		device.deviceDescriptor.idVendor === USB_VENDOR_ID_BROADCOM_CORPORATION &&
		device.deviceDescriptor.idProduct === USB_PRODUCT_ID_BCM2711_MASS_STORAGE
	);
};

const initializeDevice = (
	device: usb.Device,
): { iface: usb.Interface; endpoint: usb.OutEndpoint } => {
	// interface is a reserved keyword in TypeScript so we use iface
	device.open();
	// Handle 2837 where it can start with two interfaces, the first is mass storage
	// the second is the vendor interface for programming
	let interfaceNumber;
	let endpointNumber;
	if (
		device.configDescriptor.bNumInterfaces ===
		USB_ENDPOINT_INTERFACES_SOC_BCM2835
	) {
		interfaceNumber = 0;
		endpointNumber = 1;
	} else {
		interfaceNumber = 1;
		endpointNumber = 3;
	}
	const iface = device.interface(interfaceNumber);
	iface.claim();
	const endpoint = iface.endpoint(endpointNumber);
	if (!(endpoint instanceof usb.OutEndpoint)) {
		throw new Error('endpoint is not an usb.OutEndpoint');
	}
	debug('Initialized device correctly', devicePortId(device));
	return { iface, endpoint };
};

const sendSize = async (device: usb.Device, size: number): Promise<void> => {
	await performControlTransfer(
		device,
		usb.LIBUSB_REQUEST_TYPE_VENDOR,
		USB_REQUEST_CODE_GET_STATUS,
		size & USBBOOT_MESSAGE_MAX_BUFFER_LENGTH,
		size >> CONTROL_TRANSFER_INDEX_RIGHT_BIT_SHIFT,
		NULL_BUFFER,
	);
};

function* chunks(buffer: Buffer, size: number) {
	for (let start = 0; start < buffer.length; start += size) {
		yield buffer.slice(start, start + size);
	}
}

const transfer = async (endpoint: usb.OutEndpoint, chunk: Buffer) => {
	endpoint.timeout = USB_BULK_TRANSFER_TIMEOUT_MS;
	for (let tries = 0; tries < 3; tries++) {
		if (tries > 0) {
			debug('Transfer stall, retrying');
		}
		try {
			await fromCallback((callback) => {
				endpoint.transfer(chunk, callback);
			});
			return;
		} catch (error) {
			if (error.errno === usb.LIBUSB_TRANSFER_STALL) {
				continue;
			}
			throw error;
		}
	}
};

const epWrite = async (
	buffer: Buffer,
	device: usb.Device,
	endpoint: usb.OutEndpoint,
) => {
	debug('Sending buffer size', buffer.length);
	await sendSize(device, buffer.length);
	if (buffer.length > 0) {
		for (const chunk of chunks(buffer, TRANSFER_BLOCK_SIZE)) {
			debug('Sending chunk of size', chunk.length);
			await transfer(endpoint, chunk);
		}
	}
};

const epRead = async (
	device: usb.Device,
	bytesToRead: number,
): Promise<Buffer> => {
	return await performControlTransfer(
		device,
		usb.LIBUSB_REQUEST_TYPE_VENDOR | usb.LIBUSB_ENDPOINT_IN,
		USB_REQUEST_CODE_GET_STATUS,
		bytesToRead & USBBOOT_MESSAGE_MAX_BUFFER_LENGTH,
		bytesToRead >> CONTROL_TRANSFER_INDEX_RIGHT_BIT_SHIFT,
		bytesToRead,
	);
};

const getDeviceId = (device: usb.Device): string => {
	return `${device.busNumber}:${device.deviceAddress}`;
};

const safeReadFile = async (filename: string): Promise<Buffer | undefined> => {
	try {
		return await readFile(Path.join(__dirname, '..', 'blobs', filename));
	} catch (e) {
		// no data
	}
};

const getFileBuffer = async (
	device: usb.Device,
	filename: string,
): Promise<Buffer | undefined> => {
	const folder =
		device.deviceDescriptor.idProduct === USB_PRODUCT_ID_BCM2711_BOOT
			? 'cm4'
			: 'raspberrypi';
	const buffer = await safeReadFile(Path.join(folder, filename));
	if (buffer === undefined) {
		debug("Can't read file", filename);
	}
	return buffer;
};

/**
 * @summary Create a boot message buffer
 *
 * @description
 * This is based on the following data structure:
 *
 * typedef struct MESSAGE_S {
 *   int length;
 *   unsigned char signature[20];
 * } boot_message_t;
 *
 * This needs to be sent to the out endpoint of the USB device
 * as a 24 bytes little-endian buffer where:
 *
 * - The first 4 bytes contain the size of the bootcode.bin buffer
 * - The remaining 20 bytes contain the boot signature, which
 *   we don't make use of in this implementation
 */
const createBootMessageBuffer = (bootCodeBufferLength: number): Buffer => {
	const bootMessageBufferSize =
		BOOT_MESSAGE_BOOTCODE_LENGTH_SIZE + BOOT_MESSAGE_SIGNATURE_SIZE;
	// Buffers are automatically filled with zero bytes
	const bootMessageBuffer = Buffer.alloc(bootMessageBufferSize);
	// The bootcode length should be stored in 4 little-endian bytes
	bootMessageBuffer.writeInt32LE(
		bootCodeBufferLength,
		BOOT_MESSAGE_BOOTCODE_LENGTH_OFFSET,
	);
	return bootMessageBuffer;
};

const secondStageBoot = async (
	device: usb.Device,
	endpoint: usb.OutEndpoint,
) => {
	const bootcodeBuffer = await getFileBuffer(device, 'bootcode.bin');
	if (bootcodeBuffer === undefined) {
		throw new Error("Can't find bootcode.bin");
	}
	const bootMessage = createBootMessageBuffer(bootcodeBuffer.length);
	await epWrite(bootMessage, device, endpoint);
	debug(`Writing ${bootMessage.length} bytes`, devicePortId(device));
	await epWrite(bootcodeBuffer, device, endpoint);
	// raspberrypi's sample code has a sleep(1) here, but it looks like it isn't required.
	const data = await epRead(device, RETURN_CODE_LENGTH);
	const returnCode = data.readInt32LE(0);
	if (returnCode !== RETURN_CODE_SUCCESS) {
		throw new Error(
			`Couldn't write the bootcode, got return code ${returnCode} from device`,
		);
	}
};

export abstract class UsbbootDevice extends EventEmitter {
	public abstract readonly LAST_STEP: number;
	private _step = 0;

	constructor(public portId: string) {
		super();
	}

	get progress() {
		return Math.round((this._step / this.LAST_STEP) * 100);
	}

	get step() {
		return this._step;
	}

	set step(step: number) {
		this._step = step;
		this.emit('progress', this.progress);
	}
}

export class CM3 extends UsbbootDevice {
	// LAST_STEP is hardcoded here as it is depends on the bootcode.bin file we send to the pi.
	// List of steps:
	// 0) device connects with iSerialNumber 0 and we write bootcode.bin to it
	// 1) the device detaches
	// 2 - 38) the device reattaches with iSerialNumber 1 and we upload the files it requires (the number of steps depends on the device)
	// 39) the device detaches
	// 40) the device reattaches as a mass storage device
	public readonly LAST_STEP = 40;
}

export class CM4 extends UsbbootDevice {
	// LAST_STEP is hardcoded here as it is depends on the bootcode.bin file we send to the pi.
	// List of steps:
	// 0) device connects with iSerialNumber 0 and we write bootcode.bin to it
	// 1) the device detaches
	// 2 - 8) the device reattaches with iSerialNumber 1 and we upload the files it requires (the number of steps depends on the device)
	// 9) the device detaches
	// 10) the device reattaches as a mass storage device
	public readonly LAST_STEP = 10;
}

export class UsbbootScanner extends EventEmitter {
	private usbbootDevices = new Map<string, UsbbootDevice>();
	private boundAttachDevice: (device: usb.Device) => Promise<void>;
	private boundDetachDevice: (device: usb.Device) => void;
	private interval: number | undefined;
	// We use both events ('attach' and 'detach') and polling getDeviceList() on usb.
	// We don't know which one will trigger the this.attachDevice call.
	// So we keep track of attached devices ids in attachedDeviceIds to not run it twice.
	private attachedDeviceIds = new Set<string>();

	constructor() {
		super();
		this.boundAttachDevice = this.attachDevice.bind(this);
		this.boundDetachDevice = this.detachDevice.bind(this);
	}

	public start(): void {
		debug('Waiting for BCM2835/6/7/2711');

		// Prepare already connected devices
		usb.getDeviceList().map(this.boundAttachDevice);

		// At this point all devices from `usg.getDeviceList()` above
		// have had an 'attach' event emitted if they were raspberry pis.
		this.emit('ready');
		// Watch for new devices being plugged in and prepare them
		usb.on('attach', this.boundAttachDevice);
		// Watch for devices detaching
		usb.on('detach', this.boundDetachDevice);

		// ts-ignore because of a confusion between NodeJS.Timer and number
		// @ts-ignore
		this.interval = setInterval(() => {
			// usb.getDeviceList().forEach(this.boundAttachDevice);
		}, POLLING_INTERVAL_MS);
	}

	public stop(): void {
		usb.removeListener('attach', this.boundAttachDevice);
		usb.removeListener('detach', this.boundDetachDevice);
		clearInterval(this.interval);
		this.usbbootDevices.clear();
	}

	private step(device: usb.Device, step: number): void {
		const usbbootDevice = this.getOrCreate(device);
		usbbootDevice.step = step;
		if (step === usbbootDevice.LAST_STEP) {
			this.remove(device);
		}
	}

	private get(device: usb.Device): UsbbootDevice | undefined {
		const key = devicePortId(device);
		return this.usbbootDevices.get(key);
	}

	private getOrCreate(device: usb.Device): UsbbootDevice {
		const key = devicePortId(device);
		let usbbootDevice = this.usbbootDevices.get(key);
		if (usbbootDevice === undefined) {
			const Cls =
				device.deviceDescriptor.idProduct === USB_PRODUCT_ID_BCM2711_BOOT
					? CM4
					: CM3;
			usbbootDevice = new Cls(key);
			this.usbbootDevices.set(key, usbbootDevice);
			this.emit('attach', usbbootDevice);
		}
		return usbbootDevice;
	}

	private remove(device: usb.Device): void {
		const key = devicePortId(device);
		const usbbootDevice = this.usbbootDevices.get(key);
		if (usbbootDevice !== undefined) {
			this.usbbootDevices.delete(key);
			this.emit('detach', usbbootDevice);
		}
	}

	private async attachDevice(device: usb.Device): Promise<void> {
		if (this.attachedDeviceIds.has(getDeviceId(device))) {
			return;
		}
		this.attachedDeviceIds.add(getDeviceId(device));

		const usbbootDevice = this.get(device);
		if (
			(isRaspberryPiInMassStorageMode(device) ||
				isComputeModule4InMassStorageMode(device)) &&
			usbbootDevice !== undefined
		) {
			this.step(device, usbbootDevice.LAST_STEP);
			return;
		}
		if (!isUsbBootCapableUSBDevice$(device)) {
			return;
		}
		debug('Found serial number', device.deviceDescriptor.iSerialNumber);
		debug('port id', devicePortId(device));
		try {
			const { endpoint } = initializeDevice(device);
			// cm: 0; cm4: 3
			if (
				device.deviceDescriptor.iSerialNumber === 0 ||
				device.deviceDescriptor.iSerialNumber === 3
			) {
				debug('Sending bootcode.bin', devicePortId(device));
				this.step(device, 0);
				await secondStageBoot(device, endpoint);
				// The device will now detach and reattach with iSerialNumber 1.
				// This takes approximately 1.5 seconds
			} else {
				debug('Second stage boot server', devicePortId(device));
				await this.fileServer(device, endpoint, 2);
			}
			device.close();
		} catch (error) {
			debug('error', error, devicePortId(device));
			this.remove(device);
		}
	}

	private detachDevice(device: usb.Device): void {
		this.attachedDeviceIds.delete(getDeviceId(device));
		if (!isUsbBootCapableUSBDevice$(device)) {
			return;
		}
		const usbbootDevice = this.getOrCreate(device);
		const step =
			device.deviceDescriptor.iSerialNumber === 0
				? 1
				: usbbootDevice.LAST_STEP - 1;
		debug('detach', devicePortId(device), step);
		this.step(device, step);
		// This timeout is here to differentiate between the device resetting and the device being unplugged
		// If the step didn't changed in 5 seconds, we assume the device was unplugged.
		setTimeout(() => {
			const $usbbootDevice = this.get(device);
			if ($usbbootDevice !== undefined && $usbbootDevice.step === step) {
				debug(
					'device',
					devicePortId(device),
					'did not reattached after',
					DEVICE_UNPLUG_TIMEOUT,
					'ms.',
				);
				this.remove(device);
			}
		}, DEVICE_UNPLUG_TIMEOUT);
	}

	private async fileServer(
		device: usb.Device,
		endpoint: usb.OutEndpoint,
		step: number,
	) {
		while (true) {
			let data;
			try {
				data = await epRead(device, FILE_MESSAGE_SIZE);
			} catch (error) {
				if (
					error.message === 'LIBUSB_ERROR_NO_DEVICE' ||
					error.message === 'LIBUSB_ERROR_IO'
				) {
					// Drop out if the device goes away
					break;
				}
				await delay(READ_ERROR_DELAY);
				continue;
			}
			this.step(device, step);
			step += 1;
			const message = parseFileMessageBuffer(data);
			debug(
				'Received message',
				FileMessageCommand[message.command],
				message.filename,
				devicePortId(device),
			);
			if (
				message.command === FileMessageCommand.GetFileSize ||
				message.command === FileMessageCommand.ReadFile
			) {
				const buffer = await getFileBuffer(device, message.filename);
				if (buffer === undefined) {
					debug(`Couldn't find ${message.filename}`, devicePortId(device));
					await sendSize(device, 0);
				} else {
					if (message.command === FileMessageCommand.GetFileSize) {
						await sendSize(device, buffer.length);
					} else {
						await epWrite(buffer, device, endpoint);
					}
				}
			} else if (message.command === FileMessageCommand.Done) {
				break;
			}
		}
		debug('File server done', devicePortId(device));
		// On some computers, the rpi won't detach at this point.
		// If you try communicating with it, it will error, detach and reattach as expected.
		await delay(2000);
		try {
			device.open();
		} catch {
			// We expect LIBUSB_ERROR_IO here
		}
	}
}

const devicePortId = (device: usb.Device) => {
	let result = `${device.busNumber}`;
	if (device.portNumbers !== undefined) {
		result += `-${device.portNumbers.join('.')}`;
	}
	return result;
};
