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

let mockCreateSnapshot = jest.fn()
let mockSnapshotPromise = jest.fn()
mockCreateSnapshot.mockReturnValue({
  promise: mockSnapshotPromise
})

let mockWaitFor = jest.fn()
let mockWaitPromise = jest.fn()
mockWaitFor.mockReturnValue({
  promise: mockWaitPromise
})

jest.mock('aws-sdk', () => {
  return {
    EC2: () => {
      return {
        createSnapshot: mockCreateSnapshot,
        waitFor: mockWaitFor
      }
    }
  }
})

process.env.REGION = 'ap-southeast-2'

import { Context, ScheduledEvent } from 'aws-lambda'
import { handler } from '../src/snapshotter'

const context = contextFactory()
const callback = jest.fn()
const event = snapshotterEventFactory()

describe('When an event occurs to request a snapshot', async () => {
  beforeEach(() => {
    mockGetItem.mockClear()
    mockGetItem.mockReturnValue(Promise.resolve(MOCK_GET_ITEM))
    mockUpdateItem.mockClear()
    mockUpdateItem.mockReturnValue(Promise.resolve(MOCK_UPDATE_ITEM))
    mockSnapshotPromise.mockReturnValueOnce(Promise.resolve({SnapshotId: 'snap-066877671789bd71b'}))
  })
  it('We issue a call to get the current master volume from Dynamo', async () => {
    await handler(event, context, callback)

    expect(mockGetItem).toHaveBeenCalled()
  })
  it('We issue a call to create snapshot', async () => {
    await handler(event, context, callback)

    expect(mockSnapshotPromise).toHaveBeenCalled()
  })
  it('Create snapshot is called referencing the right volume', async () => {
    await handler(event, context, callback)

    expect(mockCreateSnapshot.mock.calls[0][0].VolumeId).toBe('fakeVolumeId')
  })
  it('We issue a call to wait for the snapshot to finish creating', async () => {
    await handler(event, context, callback)

    expect(mockWaitPromise).toHaveBeenCalled()
  })
  it('We issue an update request to Dynamo with the new snapshot id', async () => {
    await handler(event, context, callback)

    expect(mockUpdateItem).toBeCalled()
  })
  it('We issue an update request to Dynamo with the new snapshot id', async () => {
    await handler(event, context, callback)

    expect(mockUpdateItem.mock.calls[0][0].snapshotId).toBe('snap-066877671789bd71b')
  })
  it('We invoke the callback with no error', async () => {
    await handler(event, context, callback)

    expect(callback.mock.calls[0][0]).toBe(null)
  })
})

function snapshotterEventFactory(): ScheduledEvent {
  return {
    account: 'fakeAccount',
    region: 'ap-southeast-2',
    detail: 'fakeDetail',
    'detail-type': 'string',
    source: 'fakeSource',
    time: 'fakeTime',
    id: 'fakeId',
    resources: ['aResource']
  }
}

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

const MOCK_GET_ITEM = {
  id: 0,
  volumeId: 'fakeVolumeId',
  device: 'fakeDevice',
  snapshotId: 'fakeSnapshotId'
}

const MOCK_UPDATE_ITEM = {
  id: 0,
  volumeId: 'fakeVolumeId',
  device: 'fakeDevice',
  snapshotId: 'snap-066877671789bd71b'
}
