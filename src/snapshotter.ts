import { Callback, Context, ScheduledEvent } from 'aws-lambda'
import * as AWS from 'aws-sdk'
import { logger } from './logger';
import { DataMapper, DynamoDbSchema, DynamoDbTable } from '@aws/dynamodb-data-mapper';
import DynamoDB = require('aws-sdk/clients/dynamodb');

const ec2 = new AWS.EC2()
const client = new DynamoDB({region: process.env.REGION})
const mapper = new DataMapper({client})

export async function handler(event: ScheduledEvent, context: Context, callback: Callback) {
  logger.info(`Received event: ${JSON.stringify(event)}`)
  let volume = new VolumeModel()
  volume.id = '0'
  volume = await mapper.get(volume)
  const snapshotParams = {
    VolumeId: volume.volumeId
  }
  logger.info(`Parameters sent to createSnapshot: ${JSON.stringify(snapshotParams)}`)
  let snapshot = await ec2.createSnapshot(snapshotParams).promise()
  logger.info(`Response from createSnapshot: ${JSON.stringify(snapshot)}`)

  const snapshotWaitParams = {
    SnapshotIds: [snapshot.SnapshotId!]
  }
  logger.info(`Parameters sent to waitFor snapshotCompleted: ${JSON.stringify(snapshotWaitParams)}`)
  let waitFor = await ec2.waitFor('snapshotCompleted', snapshotWaitParams).promise()
  logger.info(`Response from waitFor snapshotCompleted: ${JSON.stringify(waitFor)}`)

  let newSnapshot = new VolumeModel()
  newSnapshot.device = volume.device
  newSnapshot.id = volume.id
  newSnapshot.snapshotId = snapshot.SnapshotId!
  newSnapshot.volumeId = volume.volumeId

  newSnapshot = await mapper.update(newSnapshot)

  callback(null, `Snapshot was created successfully: ${snapshot.SnapshotId!}`)
}

class VolumeModel {
  id: string
  volumeId: string
  device: string
  snapshotId
}

Object.defineProperties(VolumeModel.prototype, {
  [DynamoDbTable]: {
    value: process.env.MASTER_VOLUME_TABLE
  },
  [DynamoDbSchema]: {
    value: {
      id: {
        type: 'String',
        keyType: 'HASH'
      },
      volumeId: {type: 'String'},
      device: {type: 'String'},
      snapshotId: {type: 'String'}
    },
  },
})
