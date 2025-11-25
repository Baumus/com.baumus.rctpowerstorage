'use strict';

const RCTDriver = require('../../lib/rct-driver');
const Connection = require('../../lib/rctjavalib/connection');
const { Identifier } = require('../../lib/rctjavalib/datagram');

module.exports = class MyDriver extends RCTDriver {

  async onInit() {
    await super.onInit();
    this.log('Grid Meter Driver initialized');
  }

  onPair(session) {
    let inverter = null;

    session.setHandler('validate', async (data) => {
      this.log('Validate new connection settings');

      const connection = Connection.getPooledConnection(data.host, data.port, 5000);
      try {
        await connection.connect();
        this.log('Connection successful');

        let strInverterSN = await connection.queryString(Identifier.INVERTER_SN);
        strInverterSN = strInverterSN.split('\x00').join('');
        this.log('Inverter SN:', strInverterSN);

        inverter = {
          name: 'Grid Meter',
          data: { id: `${strInverterSN}-grid_meter` },
          store: { address: data.host, port: data.port },
        };

        connection.close();
        this.log('Grid Meter found:', inverter);
        return true;
      } catch (error) {
        this.error('Connection unsuccessful:', error);
        throw new Error('Unable to connect to device');
      }
    });

    session.setHandler('list_devices', async () => {
      if (!inverter) return [];
      
      return [
        {
          name: inverter.name,
          data: inverter.data,
          store: inverter.store,
        },
      ];
    });
  }

};
