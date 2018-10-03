let mockDescribeInstances = jest.fn()
let mockInstancesPromise = jest.fn()
mockDescribeInstances.mockReturnValue({
  promise: mockInstancesPromise
})

let mockDescribeVolumes = jest.fn()
let mockVolumesPromise = jest.fn()
mockDescribeVolumes.mockReturnValue({
  promise: mockVolumesPromise
})

let mockAttachVolume = jest.fn()
let mockAttachPromise = jest.fn()
mockAttachVolume.mockReturnValue({
  promise: mockAttachPromise
})

let mockSNSPublish = jest.fn()
let mockPublishPromise = jest.fn()
mockSNSPublish.mockReturnValue({
  promise: mockPublishPromise
})

let mockCreateSnapshot = jest.fn()
let mockSnapshotPromise = jest.fn()
mockCreateSnapshot.mockReturnValue({
  promise: mockSnapshotPromise
})

let mockCreateVolume = jest.fn()
let mockVolumePromise = jest.fn()
mockCreateVolume.mockReturnValue({
  promise: mockVolumePromise
})

jest.mock('aws-sdk', () => {
  return {
    EC2: () => {
      return {
        attachVolume: mockAttachVolume,
        createSnapshot: mockCreateSnapshot,
        createVolume: mockCreateVolume,
        describeInstances: mockDescribeInstances,
        describeVolumes: mockDescribeVolumes,
      }
    },
    SNS: () => {
      return {
        publish: mockSNSPublish,
      }
    }
  }
})

let mockGetItem = jest.fn()
let mockUpdateItem = jest.fn()
jest.mock('@aws/dynamodb-data-mapper', () => {
  return {
    DataMapper: () => {
      return {
        get: mockGetItem,
        update: mockUpdateItem
      }
    }
  }
})

process.env.MASTER_VOLUME_TABLE = 'fakeTableName'
process.env.REGION = 'ap-southeast-2'
process.env.SUPPORT_SNS_TOPIC_ARN = 'fakeSNSTopicArn'

import { handler } from '../src/autoScaleUp';
import { SNSEvent, Context } from 'aws-lambda';

describe('When receiving an event from SNS', () => {
  let event: SNSEvent;
  let context = contextFactory();
  let callback = jest.fn()
  beforeEach(() => {
    event = snsEventRecordFactory()
    mockGetItem.mockClear()
    mockGetItem.mockReturnValue(Promise.resolve(MOCK_GET_ITEM))
    mockVolumesPromise.mockReturnValue(Promise.resolve(mockDescribeVolumesFactory()))
    mockInstancesPromise.mockReturnValue(Promise.resolve(MOCK_DESCRIBE_INSTANCES))
    mockSNSPublish.mockClear()
    mockAttachPromise.mockReturnValue('')
  })
  it('We issue a call to get the status of the EC2', async () => {
    await handler(event, context, callback);

    expect(mockInstancesPromise).toHaveBeenCalled()
  })
  it('We issue a get item call to DynamoDB', async () => {
    await handler(event, context, callback)

    expect(mockGetItem).toHaveBeenCalled()
  })
  it('We issue a call to get the status of the EBS volume', async () => {
    await handler(event, context, callback)

    expect(mockVolumesPromise).toHaveBeenCalled()
  })
  describe('When the instance and volume are in the same AZ', () => {
    it('We issue a call to attach the volume to the instance', async () => {
      await handler(event, context, callback)

      expect(mockAttachPromise).toHaveBeenCalled()
    })
    it('The call to attach the volume is with the Device stored in Dynamo', async () => {
      await handler(event, context, callback)

      expect(mockAttachVolume.mock.calls[0][0].Device).toBe(fakeDevice)
    })
    describe('If the attach request fails', () => {
      beforeEach(() => {
        mockAttachPromise.mockRejectedValue(Promise.reject('SNS Error'))
      })
      it('A message is sent to a SNS topic', async () => {
        await handler(event, context, callback)

        expect(mockSNSPublish).toHaveBeenCalled()
      })
      it('The publish event is sent to the correct Topic ARN', async () => {
        await handler(event, context, callback)

        expect(mockSNSPublish.mock.calls[0][0].TopicArn).toBe(process.env.SUPPORT_SNS_TOPIC_ARN)
      })
      it('The callback is invoked with an error', async () => {
        callback.mockClear()

        await handler(event, context, callback)

        expect(callback.mock.calls[0][0]).not.toBe(null)
      })
    })
    describe('If the attach request succeeds', () => {
      it('The callback is invoked with no error', async () => {
        callback.mockClear()

        await handler(event, context, callback)

        expect(callback.mock.calls[0][0]).toBe(null)
      })
    })
  })
  describe('When the instance and volume are in different AZs', () => {
    beforeEach(() => {
      mockVolumesPromise.mockReturnValueOnce(Promise.resolve(mockDescribeVolumesFactory('ap-southeast-1b')))
      mockSnapshotPromise.mockReturnValueOnce(Promise.resolve({SnapshotId: 'snap-066877671789bd71b'}))
      mockVolumePromise.mockReturnValueOnce(Promise.resolve(MOCK_GET_ITEM))
    })
    it('We issue a call to snapshot the current master volume', async () => {
      await handler(event, context, callback)

      expect(mockSnapshotPromise).toHaveBeenCalled()
    })
    it('We issue a call to create a volume from the snapshot', async () => {
      await handler(event, context, callback)

      expect(mockCreateVolume).toHaveBeenCalled()
    })
    it('We issue a call to update the master volume in Dynamo', async () => {
      await handler(event, context, callback)

      expect(mockUpdateItem).toHaveBeenCalled()
    })
  })
})

function contextFactory(): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName: '',
    functionVersion: '',
    invokedFunctionArn: '',
    memoryLimitInMB: 1024,
    awsRequestId: '',
    logGroupName: '',
    logStreamName: '',

    getRemainingTimeInMillis(): number { return 0; },
    done(error?: Error, result?: any): void { },
    fail(error: Error | string): void { },
    succeed(message: '', object?: any): void { }
  };
}

function snsEventRecordFactory(): SNSEvent {
  return {
    'Records': [
      {
        'EventVersion': '1.0',
        'EventSubscriptionArn': 'fakeEventSubscriptionArn',
        'EventSource': 'aws:sns',
        'Sns': {
          'SignatureVersion': '1',
          'Timestamp': '1970-01-01T00:00:00.000Z',
          'Signature': 'EXAMPLE',
          'SigningCertUrl': 'EXAMPLE',
          'MessageId': '95df01b4-ee98-5cb9-9903-4c221d41eb5e',
          'Message': 'Hello from SNS!',
          'MessageAttributes': {
            'Service': {
              'Type': 'String',
              'Value': 'AWS Auto Scaling'
            },
            'Time': {
              'Type': 'String',
              'Value': '2016-09-30T20:42:11.305Z'
            },
            'RequestId': {
              'Type': 'String',
              'Value': '18b2ec17-3e9b-4c15-8024-ff2e8ce8786a'
            },
            'LifecycleActionToken': {
              'Type': 'String',
              'Value': '71514b9d-6a40-4b26-8523-05e7ee35fa40'
            },
            'AccountId': {
              'Type': 'String',
              'Value': '123456789012'
            },
            'AutoScalingGroupName': {
              'Type': 'String',
              'Value': 'my-asg'
            },
            'LifecycleHookName': {
              'Type': 'String',
              'Value': 'my-hook'
            },
            'EC2InstanceId': {
              'Type': 'String',
              'Value': 'i-0598c7d356eba48d7'
            },
            'LifecycleTransition': {
              'Type': 'String',
              'Value': 'autoscaling:EC2_INSTANCE_LAUNCHING'
            },
            'NotificationMetadata': {
              'Type': 'String',
              'Value': 'null'
            }
          },
          'Type': 'Notification',
          'UnsubscribeUrl': 'EXAMPLE',
          'TopicArn': 'fakeTopicArn',
          'Subject': 'TestInvoke'
        }
      }
    ]
  }
}

const fakeDevice = 'fakeDevice'
const MOCK_GET_ITEM = {
  id: 0,
  volumeId: 'fakeVolumeId',
  device: fakeDevice
}

function mockDescribeVolumesFactory(az: string = 'ap-southeast-1a') {
  return {
    NextToken: '',
    Volumes: [
      {
        Attachments: [
          {
            AttachTime: 'fakeTime',
            DeleteOnTermination: true,
            Device: '/dev/sda1',
            InstanceId: 'i-1234567890abcdef0',
            State: 'attached',
            VolumeId: 'vol-049df61146c4d7901'
          }
        ],
        AvailabilityZone: az,
        CreateTime: 'fakeTime',
        Size: 8,
        SnapshotId: 'snap-1234567890abcdef0',
        State: 'in-use',
        VolumeId: 'vol-049df61146c4d7901',
        VolumeType: 'standard'
      }
    ]
  }
}

const MOCK_DESCRIBE_INSTANCES = {
  Reservations: [{
    Instances: [{
      Placement: {
        AvailabilityZone: 'ap-southeast-1a'
      }
    }]
  }]
}
