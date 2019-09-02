'use strict';

const Bluetooth = require('node-web-bluetooth');

class SelectFirstFoundDevice extends Bluetooth.RequestDeviceDelegate {
 
    // Select first device found
    onAddDevice(device) {
        this.resolve(device);
    }
 
    // Time-out when device hasn't been found in 15 secs
    onStartScan() {
        this._timer = setTimeout(() => {
            this.reject(new Error('No device found'));
        }, 15000);
    }

    onStopScan() {
        if (this._timer) clearTimeout(this._timer);
    }
}

module.exports = SelectFirstFoundDevice;