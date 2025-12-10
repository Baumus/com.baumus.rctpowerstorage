'use strict';

const Homey = require('homey');
const Connection = require('./rctjavalib/connection');
const { Identifier } = require('./rctjavalib/datagram');

module.exports = class RCTDriver extends Homey.Driver {

  async onInit() {
    this.log('RCTDriver initialized');
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
          name: 'RCT Power Storage DC',
          data: { id: strInverterSN },
          store: { address: data.host, port: data.port },
        };

        connection.close();
        this.log('Inverter found:', inverter);
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
        {
          name: 'Solar Panel',
          data: { id: `${inverter.data.id}-solar_panel` },
          store: inverter.store,
        },
      ];
    });
  }

};
