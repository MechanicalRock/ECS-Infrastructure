import * as AWS from 'aws-sdk'
import { DataMapper, DynamoDbSchema, DynamoDbTable } from '@aws/dynamodb-data-mapper';
import DynamoDB = require('aws-sdk/clients/dynamodb');
import { Callback, Context, SNSEvent } from 'aws-lambda';
import { PromiseResult } from 'aws-sdk/lib/request';
import { logger } from './logger'

const ec2 = new AWS.EC2()
const client = new DynamoDB({region: process.env.REGION})
const mapper = new DataMapper({client})

export async function handler(event: SNSEvent, context: Context, callback: Callback) {
  let instanceId
  let volumeItem
  try {
    logger.info(`SNS event received: ${JSON.stringify(event)}`)
    const message = JSON.parse(event.Records[0].Sns.Message)
    instanceId = message.EC2InstanceId.Value
    let instance = await getInstanceData(instanceId)
    volumeItem = await getVolumeItem()
    let volume = await getVolumeData(volumeItem.volumeId)
    if (instance.Placement!.AvailabilityZone! === volume.AvailabilityZone) {
      let request = ec2.attachVolume({
        Device: volumeItem.device,
        InstanceId: instanceId,
        VolumeId: volumeItem.volumeId
      }).promise()
      try {
        await request
        callback(null, 'EC2 machine has been correctly provisioned')
      } catch (error) {
        console.log(error)
        await publishErrorToSNS(instanceId, volumeItem.volumeId)
        callback(error, null)
      }
    } else {
      await createNewVolume(volumeItem, instance.Placement!.AvailabilityZone!)
      callback(null, 'EC2 machine has been correctly provisioned')
    }
  } catch (error) {
    logger.error(`Error thrown, publishing to SNS and invoking the callback ${JSON.stringify(error)}`)
    await publishErrorToSNS(instanceId, volumeItem)
    callback(error, null)
  }
}

async function getInstanceData(id: string): Promise<AWS.EC2.Instance> {
  const params = {
    InstanceIds: [id]
  }
  logger.info(`Parameters sent to describeInstances: ${JSON.stringify(params)}`)
  const data = await ec2.describeInstances(params).promise()
  logger.info(`Response from describeInstances: ${JSON.stringify(data)}`)
  return data.Reservations![0].Instances![0]
}

async function getVolumeItem() {
  let model = new VolumeModel()
  model.id = '0'
  model = await mapper.get(model)
  logger.info(`Response from getItem: ${JSON.stringify(model)}`)
  return model
}

async function getVolumeData(id: string) {
  const params = {
    VolumeIds: [id]
  }
  logger.info(`Parameters sent to describeVolumes: ${JSON.stringify(params)}`)
  let data = await ec2.describeVolumes(params).promise()
  logger.info(`Response from describeVolumes: ${JSON.stringify(data)}`)
  return data.Volumes![0]
}

async function publishErrorToSNS(instanceId: string, volume: VolumeModel) {
  const SNS = new AWS.SNS()
  let message
  if (volume) {
    message = `Error attaching volume to EC2 machine, instanceId: ${instanceId}, volumeId: ${volume.volumeId}`
  } else {
    `Error attaching volume to EC2 machine, instanceId: ${instanceId}, unknown volume`
  }
  const params = {
    Message: message,
    TopicArn: process.env.SUPPORT_SNS_TOPIC_ARN
  }
  logger.info(`Parameters sent to SNS.publish: ${JSON.stringify(params)}`)
  let data = await SNS.publish(params).promise()
  logger.info(`Response from SNS.publish: ${JSON.stringify(data)}`)
}

async function createNewVolume(volumeModel: VolumeModel, az: string) {
  const snapshotParams = {
    VolumeId: volumeModel.volumeId
  }
  logger.info(`Parameters sent createSnapshot: ${JSON.stringify(snapshotParams)}`)
  let snapshot = await ec2.createSnapshot(snapshotParams).promise()
  logger.info(`Response from createSnapshot: ${JSON.stringify(snapshot)}`)

  const volumeParams = {
    AvailabilityZone: az,
    SnapshotId: snapshot.SnapshotId!
  }
  logger.info(`Parameters sent createVolume: ${JSON.stringify(volumeParams)}`)
  let volume = await ec2.createVolume(volumeParams).promise()
  logger.info(`Response from createVolume: ${JSON.stringify(volumeParams)}`)

  await updateMasterVolumeInDynamo(volume, volumeModel)
}

async function updateMasterVolumeInDynamo(volume: PromiseResult<AWS.EC2.Volume, AWS.AWSError>, volumeModel: VolumeModel) {
  let newVolumeModel = { ...volumeModel }
  newVolumeModel.volumeId = volume.VolumeId!

  logger.info(`Model to be updated in Dynamo: ${JSON.stringify(newVolumeModel)}`)
  newVolumeModel = await mapper.update(newVolumeModel)
  logger.info(`Model after update in Dynamo: ${JSON.stringify(newVolumeModel)}`)
}

class VolumeModel {
  id: string
  volumeId: string
  device: string
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
      device: {type: 'String'}
    },
  },
})
