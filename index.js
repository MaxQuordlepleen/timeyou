const Bluetooth = require('node-web-bluetooth');
const dayjs = require('dayjs');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();
const homedir = require('os').homedir();
const fs = require('fs');
const SelectFirstFoundDevice = require('./bt.js');

//timeular mac address (default, not set)
//path to timeular config file (default ~/.timeyou/config.json)
//minimum activity length (default 5 minutes)
//path to SQLite db (default, ~/.timeyou/)

// switches
// Config mode: pair device and set MAC, set activities/minimum activity length, locations -> (MVP: pair, display MAC, show upmost face #, auto switch to this on first run)
// Generate reports/output data -> (MVP: csv output)
// help/info -> (MVP: Version number, switches)
// recording mode - Actually record data in database

//TODO: think about what to do when the system is idle in some activity modes (i.e. development)
//https://www.npmjs.com/package/desktop-idle

const PRIMARY_SERVICE_UUID = 'c7e70010-c847-11e6-8175-8c89a55d403c';
const EVENTCHANGE_CHARACTERISTIC_UUID = 'c7e70012-c847-11e6-8175-8c89a55d403c';


//Allow override of this setting from commandline
const configFilePath = homedir + '/.timeyou/config.json';
let configFileContents = '{}';

try {
    configFileContents = fs.readFileSync(configFilePath);
}
catch (e) {
    switch(e.code)
    {
        case 'ENOENT': 
            console.log('Config file not found at ', configFilePath, '- using defaults.');
            break;
        default:
            console.dir({error: e}, {depth: 3, colors: true});
            process.exit(1);
    }
}


const defaultConfig = {
    devicemac: "",
    dbpath: homedir + '/.timeyou/timeyou.db',
    minimumactivitylength: 300,
    activities: []
};

const config = Object.assign({}, JSON.parse(configFileContents), defaultConfig);

const initdb = (dbpath) => {
    let db = new sqlite3.Database(dbpath, (err) => {

        if (err) {
            console.error(err.message);
            console.dir({err, dbpath});
        } else {
            console.log('Connected to the timeyou database.');

            db.serialize(() => {
                db.run('CREATE TABLE IF NOT EXISTS activity_events(id integer primary key, start_time int, finish_time int, activity_id int);')
                    .run('CREATE TABLE IF NOT EXISTS activities(id integer primary key, date_added int, face_id int, activity_string text);');
            });
        }
    });

    return db;
};

const logActivityChange = (db, deviceFace, oldDeviceFace, activitySet) => {

    //Check we aren't just changing from "no activity" to a different "no activity"
    if (activitySet[deviceFace] || activitySet[oldDeviceFace]) {

        let formerActivity = activitySet[oldDeviceFace] ? activitySet[oldDeviceFace].description : 'nothing';
        let currentActivity= activitySet[deviceFace] ? activitySet[deviceFace].description : 'nothing'

        // TODO: If we haven't done old Activity for more than config.minimumactivitylength then remove the unfinished activity
        // and add our new activity

        db.serialize(() => {
            //The weird query syntax [ update where id in subquery ] is because of https://github.com/mapbox/node-sqlite3/issues/306
            db.run(`UPDATE activity_events SET finish_time = strftime('%s','now') 
                    WHERE id IN (
                        SELECT id FROM activity_events 
                        WHERE finish_time IS NULL 
                        AND activity_id = ${activitySet[oldDeviceFace] ? activitySet[oldDeviceFace].id : -1}
                        ORDER BY start_time DESC 
                        LIMIT 1);
                    `);
            // if there is no value for activitySet[deviceFace] then it's "nothing" so don't start a new task
            if (activitySet[deviceFace]) {
                db.run(`INSERT INTO activity_events(start_time, activity_id)
                VALUES(strftime('%s','now'), ${activitySet[deviceFace].id});`,
                (err) => {
                    if (err) {
                        console.dir(err.stack);
                        throw err;
                    }
                    console.log('Changed activity from %s to %s at %s', formerActivity, currentActivity, dayjs(Date.now()).format('YYYY-MM-DD HH:mm:ss'));
                });
            } else {
                console.log('Finished doing %s at %s - no current activity', formerActivity, dayjs(Date.now()).format('YYYY-MM-DD HH:mm:ss'));
            }
        });
    }
};

const getLatestActivityCodes = async (db) => {

    let activitySet = [];

    await db.serialize( () => {
        db.all(`
            SELECT a.id, a.face_id, a.activity_string 
            FROM activities a 
            INNER JOIN (
                    SELECT face_id, max(date_added) mrd 
                    FROM activities 
                    GROUP BY face_id
            ) mra 
            ON mra.mrd = a.date_added;`, 
            [],  
            (err, rows) => {
                rows.forEach(row => {
                    activitySet[row.face_id] = {
                        description: row.activity_string,
                        id: row.id
                    };
                });
        });
    });

    return activitySet;
    
};

async function connect() {
    const device = await Bluetooth.requestDevice({
        filters: [
            { name: 'Timeular ZEI' }
        ],
        delegate: new SelectFirstFoundDevice()
    });

    return device;
}

readline.emitKeypressEvents(process.stdin);

process.stdin.setRawMode(true);

console.log('Starting, q to quit');

connect()
    .then( async (device) => {

        let db = initdb(config.dbpath);

        let latestActivitySet = await getLatestActivityCodes(db);

        const server = await device.gatt.connect();

        const handleKeyboardInput = async (str, key) => {
            //   if (key.ctrl && key.name === 'c') {
                // TODO: Enable pomodoro mode
                if (key.name === 'q') {
                    process.stdin.removeListener('keypress', handleKeyboardInput);
                    //TODO: set finish time on most recently started task
                    console.log('Finishing current task...');
                    logActivityChange(db, -1, activityValue, latestActivitySet);
                    console.log('Disconnecting from device...');
                    await device.gatt.disconnect();
                    console.log('Exiting...');
                    process.exit(0);
                }
            };

        const service = await server.getPrimaryService(PRIMARY_SERVICE_UUID);

        const charA = await service.getCharacteristic(EVENTCHANGE_CHARACTERISTIC_UUID);

        process.stdin.on('keypress', handleKeyboardInput);

        await charA.startNotifications();

        console.log('Connected to Timeular ZEI');

        let activityValue = (await charA.readValue()).getInt8(0);

        logActivityChange(db, activityValue, -1, latestActivitySet);

        charA.on('characteristicvaluechanged', (data) => {
            let oldActivityValue = activityValue;
            activityValue = charA.value.getInt8(0);
            logActivityChange(db, activityValue, oldActivityValue, latestActivitySet);
        });

    })
    .catch( e => {
        console.dir(e, {depth: 2, colors: true});
        process.exit(1);
    });


