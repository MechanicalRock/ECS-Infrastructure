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
    instanceId = message.EC2InstanceId
    let instance = await getInstanceData(instanceId)
    volumeItem = await getVolumeItem()
    let volume
    try {
      volume = await getVolumeData(volumeItem.volumeId)
    } catch {
      volumeItem = await createNewVolume(volumeItem.snapshotId, volumeItem, instance.Placement!.AvailabilityZone!, callback)
      await attachVolume(volumeItem, instance, callback)
      await mountVolume(instance.InstanceId!, callback)
      callback(null, 'EC2 machine has been correctly provisioned')
    }
    if (instance.Placement!.AvailabilityZone! !== volume.AvailabilityZone) {
      volumeItem = await createNewVolumeFromVolume(volumeItem, instance.Placement!.AvailabilityZone!, callback)
      logger.info(`Volume item: ${JSON.stringify(volumeItem)}`)
    }
    await attachVolume(volumeItem, instance, callback)
    await mountVolume(instance.InstanceId!, callback)
    callback(null, 'EC2 machine has been correctly provisioned')
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

async function attachVolume(volumeItem, instance, callback) {
  try {
    const waitForParams = {
      InstanceIds: [instance.InstanceId!]
    }
    logger.info(`Parameters sent to waitFor instanceRunning: ${JSON.stringify(waitForParams)}`)
    let waitFor = await ec2.waitFor('instanceRunning', waitForParams).promise()
    logger.info(`Response from waitFor instanceRunning: ${JSON.stringify(waitFor)}`)
    const params = {
      Device: volumeItem.device,
      InstanceId: instance.InstanceId!,
      VolumeId: volumeItem.volumeId
    }
    logger.info(`Parameters sent to attachVolume: ${JSON.stringify(params)}`)
    let response = await ec2.attachVolume(params).promise()
    logger.info(`Response from attachVolume: ${JSON.stringify(response)}`)
    const volumeParams = {
      VolumeId: volumeItem.volumeId
    }
    logger.info(`Parameters sent to waitFor volumeInUse: ${JSON.stringify(volumeParams)}`)
    let volumeWaitFor = await ec2.waitFor('volumeInUse', volumeParams)
    logger.info(`Response from waitFor instanceRunning: ${JSON.stringify(volumeWaitFor)}`)
  } catch (error) {
    logger.error(`Error received from sendCommand: ${JSON.stringify(error)}`)
    await publishErrorToSNS(instance.InstanceId!, volumeItem.volumeId)
    callback(error, null)
  }
}

async function mountVolume(instanceId, callback) {
  try {
    const commandParams = {
      CloudWatchOutputConfig: {
        CloudWatchOutputEnabled: true
      },
      DocumentName: process.env.DOCUMENT_NAME!,
      InstanceIds: [instanceId]
    }
    logger.info(`Parameters sent to sendCommand: ${JSON.stringify(commandParams)}`)
    let SSM = new AWS.SSM()
    let ssmResponse = await SSM.sendCommand(commandParams).promise()
    logger.info(`Response from sendCommand: ${JSON.stringify(ssmResponse)}`)
  } catch (error) {
    logger.error(`Error mounting volume: ${error}`)
    await publishErrorToSNS(instanceId)
    callback(error, null)
  }
}

async function createNewVolumeFromVolume(volumeModel: VolumeModel, az: string, callback: Callback) {
  try {
    const snapshotParams = {
      VolumeId: volumeModel.volumeId,
      TagSpecifications: [{
        ResourceType: 'snapshot',
        Tags: [{
          Key: 'Name',
          Value: 'ECSDataBackup'
        }]
      }]
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

    volumeModel.snapshotId = snapshot.SnapshotId!

    logger.info(`Model to be updated in Dynamo: ${JSON.stringify(volumeModel)}`)
    volumeModel = await mapper.update(volumeModel)
    logger.info(`Model after update in Dynamo: ${JSON.stringify(volumeModel)}`)

    let volume = await createNewVolume(snapshot.SnapshotId!, volumeModel, az, callback)
    return volume
  } catch (error) {
    logger.error(`Error creating volume: ${JSON.stringify(error)}`)
    await publishErrorToSNS('', volumeModel.volumeId)
    callback(error, null)
  }
}

async function createNewVolume(snapshotId, volumeModel, az, callback) {
  try {
    const volumeParams = {
      AvailabilityZone: az,
      Size: 500,
      SnapshotId: snapshotId,
      VolumeType: "sc1"
    }
    logger.info(`Parameters sent createVolume: ${JSON.stringify(volumeParams)}`)
    let volume = await ec2.createVolume(volumeParams).promise()
    logger.info(`Response from createVolume: ${JSON.stringify(volumeParams)}`)

    const volumeWaitParams = {
      VolumeIds: [volume.VolumeId!]
    }
    logger.info(`Parameters sent to waitFor volumeAvailable: ${JSON.stringify(volumeWaitParams)}`)
    let waitForVolume = await ec2.waitFor('volumeAvailable', volumeWaitParams).promise()
    logger.info(`Response from waitFor volumeAvailable: ${JSON.stringify(waitForVolume)}`)

    volumeModel = await updateMasterVolumeInDynamo(volume, volumeModel)

    return volumeModel
  } catch (error) {
    logger.error(`Error creating volume: ${JSON.stringify(error)}`)
    await publishErrorToSNS('', volumeModel.volumeId)
    callback(error, null)
  }
}

async function publishErrorToSNS(instanceId: string, volumeId: string | undefined = undefined) {
  const SNS = new AWS.SNS()
  let message
  if (volumeId) {
    message = `Error attaching volume to EC2 machine, instanceId: ${instanceId}, volumeId: ${volumeId}`
  } else {
    `Error attaching volume to EC2 machine, instanceId: ${instanceId}`
  }
  const params = {
    Message: message,
    TopicArn: process.env.SUPPORT_SNS_TOPIC_ARN
  }
  logger.info(`Parameters sent to SNS.publish: ${JSON.stringify(params)}`)
  let data = await SNS.publish(params).promise()
  logger.info(`Response from SNS.publish: ${JSON.stringify(data)}`)
}

async function updateMasterVolumeInDynamo(volume: PromiseResult<AWS.EC2.Volume, AWS.AWSError>, volumeModel: VolumeModel) {
  logger.info(`${JSON.stringify(volume)}`)
  let newVolumeModel = new VolumeModel()
  newVolumeModel.volumeId = volume.VolumeId!
  newVolumeModel.id = volumeModel.id
  newVolumeModel.device = volumeModel.device

  logger.info(`Model to be updated in Dynamo: ${JSON.stringify(newVolumeModel)}`)
  newVolumeModel = await mapper.update(newVolumeModel)
  logger.info(`Model after update in Dynamo: ${JSON.stringify(newVolumeModel)}`)

  return newVolumeModel
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
