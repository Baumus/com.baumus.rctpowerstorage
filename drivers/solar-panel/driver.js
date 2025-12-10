'use strict';

const RCTDriver = require('../../lib/rct-driver');
const Connection = require('../../lib/rctjavalib/connection');
const { Identifier } = require('../../lib/rctjavalib/datagram');

module.exports = class MyDriver extends RCTDriver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    await super.onInit();
    this.log('Solar Panel Driver initialized');
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
          name: 'Solar Panel',
          data: { id: `${strInverterSN}-solar_panel` },
          store: { address: data.host, port: data.port },
        };

        connection.close();
        this.log('Solar Panel found:', inverter);
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
