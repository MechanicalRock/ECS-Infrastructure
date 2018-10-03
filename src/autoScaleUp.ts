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
  const instanceId = event.Records[0].Sns.MessageAttributes.EC2InstanceId.Value
  let instance = await getInstanceData(instanceId)
  let volumeItem = await getVolumeItem()
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
  }
}

async function getInstanceData(id: string): Promise<AWS.EC2.Instance> {
  const request = ec2.describeInstances({
    InstanceIds: [id]
  }).promise()
  let data = await request
  console.log(data)
  return data.Reservations![0].Instances![0]
}

async function getVolumeItem() {
  let model = new VolumeModel()
  model.id = '0'
  model = await mapper.get(model)
  return model
}

async function getVolumeData(id: string) {
  const request = ec2.describeVolumes({
    VolumeIds: [id]
  }).promise()
  let data = await request
  console.log(data)
  return data.Volumes![0]
}

async function publishErrorToSNS(instanceId: string, volumeId: string) {
  const SNS = new AWS.SNS()
  await SNS.publish({
    Message: `Error attaching volume to EC2 machine, instanceId: ${instanceId}, volumeId: ${volumeId}`,
    TopicArn: process.env.SUPPORT_SNS_TOPIC_ARN
  }).promise()
}

async function createNewVolume(volumeModel: VolumeModel, az: string) {
  const snapshotRequest = ec2.createSnapshot({
    VolumeId: volumeModel.volumeId
  }).promise()
  let snapshot = await snapshotRequest

  const volumeRequest = ec2.createVolume({
    AvailabilityZone: az,
    SnapshotId: snapshot.SnapshotId!
  }).promise()
  let volume = await volumeRequest

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
