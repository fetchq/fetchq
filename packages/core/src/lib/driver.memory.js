import { FetchQDriver, FetchQQueue } from './interfaces'
import { STATUS_INITIALIZING } from './interfaces'
import { addTime, parse as parseDate } from './dates'

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

const docStatus = date => date > new Date() ? FetchQQueue.status.PLANNED : FetchQQueue.status.PENDING

const docDefaults = doc => {
    const nextIteration = parseDate(doc.nextIteration)

    return {
        subject: doc.subject || 'jdhoe', // maybe uuid?
        payload: doc.payload || {},
        lastIteration: doc.lastIteration || null,
        status: docStatus(nextIteration),
        attempts: 0,
        iterations: 0,
        nextIteration,
    }
}

// Produces a sorted list of pending documents
const flatDocs = docs => {
    const list = Object.keys(docs)
        .map(subject => docs[subject])
        .filter(doc => doc.status === FetchQQueue.status.PENDING)

    list.sort((a, b) => a.nextIteration - b.nextIteration)
    return list
}

export class MemoryQueue extends FetchQQueue {
    async init () {
        this.status = STATUS_INITIALIZING
        await pause()

        this.docs = {}
        this.list = []
        
        this.counters = {
            pkd: 0,
            drp: 0,
            err: 0,
        }

        this.settings.tolerance = 5

        return super.init()
    }

    async push (docs) {
        const res = await super.push()
        let hasPending = false

        docs.forEach(doc => {
            const { subject } = doc

            if (this.docs[subject]) {
                res.skipped++
                return
            }

            this.docs[subject] = docDefaults(doc)
            hasPending = hasPending || this.docs[subject].status === FetchQQueue.status.PENDING
            res.created++
        })

        this.list = flatDocs(this.docs)

        if (hasPending) {
            this.emit('pending')
        }

        return res
    }

    async get (subject) {
        await super.get()

        if (this.docs[subject]) {
            return this.docs[subject]
        }

        return null
    }

    async pick ({ limit = 1, lock = '5m' } = {}) {
        await super.pick()

        const docs = this.list
            .slice(0, limit)
            .map(doc => {
                doc.nextIteration = addTime(Date.now(), lock)
                doc.status = FetchQQueue.status.ACTIVE
                doc.attempts += 1
                return doc
            })

        this.counters.pkd += docs.length
        this.list = flatDocs(this.docs)
        return docs
    }

    async reschedule (doc, nextIterationPlan) {
        await super.reschedule()

        const { subject } = doc
        const nextIteration = parseDate(nextIterationPlan)

        this.docs[subject].nextIteration = nextIteration
        this.docs[subject].lastIteration = parseDate()
        this.docs[subject].status = docStatus(nextIteration)
        this.docs[subject].attempts = 0
        this.docs[subject].iterations += 1

        this.list = flatDocs(this.docs)
        return this
    }

    async reject (doc, err, nextIterationPlan) {
        await super.reject()

        const { subject } = doc
        const nextIteration = nextIterationPlan
            ? parseDate(nextIterationPlan)
            : doc.nextIteration

        this.docs[subject].nextIteration = nextIteration
        this.docs[subject].lastIteration = parseDate()
        this.docs[subject].iterations += 1

        this.docs[subject].status = this.docs[subject].attempts >= this.settings.tolerance
            ? FetchQQueue.status.KILLED
            : docStatus(nextIteration)
        
        this.counters.err += 1
        this.list = flatDocs(this.docs)
        return this
    }

    async complete (doc) {
        await super.complete()

        const { subject } = doc

        this.docs[subject].lastIteration = parseDate()
        this.docs[subject].status = FetchQQueue.status.COMPLETED
        this.docs[subject].attempts = 0
        this.docs[subject].iterations += 1

        this.list = flatDocs(this.docs)
        return this
    }
    
    async kill (doc) {
        await super.kill()

        const { subject } = doc

        this.docs[subject].lastIteration = parseDate()
        this.docs[subject].status = FetchQQueue.status.KILLED
        this.docs[subject].attempts = 0
        this.docs[subject].iterations += 1

        this.list = flatDocs(this.docs)
        return this
    }

    async drop (doc) {
        await super.drop()
        delete(this.docs[doc.subject])

        this.counters.drp += 1
        this.list = flatDocs(this.docs)
        return this
    }

    async stats () {
        const res = await super.stats()

        Object.values(this.docs).forEach(doc => {
            switch (doc.status) {
                case FetchQQueue.status.PLANNED:
                    res.pln += 1
                    break;
                case FetchQQueue.status.PENDING:
                    res.pnd += 1
                    break;
                case FetchQQueue.status.ACTIVE:
                    res.act += 1
                    break;
                case FetchQQueue.status.COMPLETED:
                    res.cpl += 1
                    break;
                case FetchQQueue.status.KILLED:
                    res.kll += 1
                    break;
            }
        })

        return {
            ...res,
            ...this.counters,
            cnt: Object.keys(this.docs).length,
        }
    }

    async mntMakePending (settings = {}) {
        const res = await super.mntMakePending(settings)

        Object.values(this.docs).forEach(doc => {
            if (doc.status !== FetchQQueue.status.PLANNED) return
            if (doc.nextIteration > Date.now()) return
            doc.status = FetchQQueue.status.PENDING
            res.affected += 1
        })

        this.list = flatDocs(this.docs)

        if (res.affected) {
            this.emit('pending')
        }

        return res
    }
}

export class MemoryDriver extends  FetchQDriver {
    constructor (config, client) {
        super(config, client)
        this.queueConstructor = MemoryQueue
    }

    async init () {
        this.status = STATUS_INITIALIZING
        await pause()
        return super.init()
    }
}
