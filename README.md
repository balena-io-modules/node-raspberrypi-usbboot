# node-rasbberrypi-usbboot

Transforms Raspberry Pi Compute Modules and Zeros to mass storage devices.

## Usage

For usage, see [the example](lib/main.ts).

On most GNU/Linux distributions, you'll need to run this as root.

Import `UsbbootScanner`, instanciate it, then on the instance attach the following event listeners:
 * `attach`: a device was connected and we started transforming it to a mass storage device;
 * `detach`: a device was detached, note that this could mean that it was physically detached or that it was successfully transformed into a mass storage device;
 * `error`: an error occured.

The `attach` and `detach` event listeners will get a `UsbbootDevice` as parameter. This object will emit `progress` events which parameter is the percentage of completion.
The progress will be `100` when the device reattaches itself as a mass storage device. This will be followed by a `detach` event from the `UsbbootScanner` (because the device
will no longer be a usbboot device).

## Details

This is heavily based on [Raspberry Pi USB booting code](https://github.com/raspberrypi/usbboot).

It should support Raspberry Pi Compute Modules and Raspberry Pi Zeros.

This module will upload a slightly more complex kernel to the pis than the original code above, it allows the devices
to reach higher write speeds at the cost of a longer preparation phase.

## Troubleshooting

If you have any trouble using this module, please check if it works with the original usb boot link above.

You can enable debug output by setting the `DEBUG` env var to `node-raspberrypi-usbboot`.
