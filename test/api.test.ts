import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {TOTAL_SLOTS} from '../src/shared/allocation';

const CONFIG_50_50=JSON.stringify({flag:'checkout',variants:[{key:'control',weight:50},{key:'treatment',weight:50}]},null,2);
const CONFIG_DECIMALS=JSON.stringify({flag:'ranking',variants:[{key:'control',weight:33.33},{key:'treatment-a',weight:33.33},{key:'treatment-b',weight:33.34}]},null,2);

async function put(id:string,content:string,status=200){
  const app=createApp();
  const before=await request(app).get('/api/flags/'+id).expect(200);
  return request(app).put('/api/flags/'+id).send({content,revision:before.body.revision}).expect(status);
}

describe('service',()=>{
  it('loads and conditionally updates a record',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/flags/alpha').expect(200);
    await request(app).put('/api/flags/alpha').send({content:'updated',revision:before.body.revision}).expect(200);
    await request(app).put('/api/flags/alpha').send({content:'stale',revision:before.body.revision}).expect(409);
  });
});

describe('variant slot allocation API',()=>{
  it('accepts a valid config and returns contiguous half-open slot ranges',async()=>{
    const saved=await put('alpha',CONFIG_50_50);
    const ranges=saved.body.allocation.ranges;
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({key:'control',start:0,end:5000,slots:5000});
    expect(ranges[1]).toMatchObject({key:'treatment',start:5000,end:TOTAL_SLOTS,slots:5000});
    expect(saved.body.allocation.totalSlots).toBe(TOTAL_SLOTS);
  });

  it('rejects a config whose weights do not sum to 100 and keeps the old content',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/flags/beta').expect(200);
    const bad=JSON.stringify({variants:[{key:'a',weight:60},{key:'b',weight:60}]});
    const rejected=await request(app).put('/api/flags/beta').send({content:bad,revision:before.body.revision}).expect(422);
    expect(rejected.body.error).toBe('invalid_config');
    expect(rejected.body.issues.some((issue:{code:string})=>issue.code==='weight_sum')).toBe(true);
    const after=await request(app).get('/api/flags/beta').expect(200);
    expect(after.body.revision).toBe(before.body.revision);
    expect(after.body.content).toBe(before.body.content);
  });

  it('rejects malformed variant entries with diagnostics',async()=>{
    const app=createApp();
    const before=await request(app).get('/api/flags/beta').expect(200);
    const bad=JSON.stringify({variants:[{key:'a',weight:'lots'},{key:'a',weight:100}]});
    const rejected=await request(app).put('/api/flags/beta').send({content:bad,revision:before.body.revision}).expect(422);
    expect(rejected.body.issues.length).toBeGreaterThan(0);
  });

  it('still accepts legacy plain-text content without allocation',async()=>{
    const saved=await put('alpha','evaluation rules: plain text');
    expect(saved.body.allocation).toBeNull();
    await put('alpha',CONFIG_50_50);
  });

  it('produces identical allocations when variant order changes',async()=>{
    await put('alpha',CONFIG_DECIMALS);
    const first=(await request(createApp()).get('/api/flags/alpha').expect(200)).body.allocation;
    const reordered=JSON.stringify({flag:'ranking',variants:[{key:'treatment-b',weight:33.34},{key:'control',weight:33.33},{key:'treatment-a',weight:33.33}]},null,2);
    await put('alpha',reordered);
    const second=(await request(createApp()).get('/api/flags/alpha').expect(200)).body.allocation;
    expect(second.ranges).toEqual(first.ranges);
    const userIds=Array.from({length:50},(_,index)=>'user-'+index);
    for(const userId of userIds){
      const assignment=await request(createApp()).post('/api/flags/alpha/assign').send({userId}).expect(200);
      expect(first.ranges.find((range:{key:string;start:number;end:number})=>range.key===assignment.body.variant)).toBeTruthy();
    }
  });

  it('assigns users deterministically into in-range slots',async()=>{
    await put('alpha',CONFIG_50_50);
    const app=createApp();
    const first=await request(app).post('/api/flags/alpha/assign').send({userId:'alice'}).expect(200);
    expect(first.body.slot).toBeGreaterThanOrEqual(0);
    expect(first.body.slot).toBeLessThan(TOTAL_SLOTS);
    expect(['control','treatment']).toContain(first.body.variant);
    const again=await request(app).post('/api/flags/alpha/assign').send({userId:'alice'}).expect(200);
    expect(again.body).toEqual(first.body);
    await request(app).post('/api/flags/alpha/assign').send({}).expect(400);
  });

  it('assigns every user to the single 100% variant',async()=>{
    await put('alpha',JSON.stringify({variants:[{key:'off',weight:0},{key:'on',weight:100}]}));
    const app=createApp();
    for(const userId of ['u1','u2','u3','u4','u5']){
      const assignment=await request(app).post('/api/flags/alpha/assign').send({userId}).expect(200);
      expect(assignment.body.variant).toBe('on');
    }
  });

  it('returns 422 when assigning or simulating on non-config content',async()=>{
    await put('alpha','plain text rules');
    const app=createApp();
    await request(app).post('/api/flags/alpha/assign').send({userId:'alice'}).expect(422);
    await request(app).post('/api/flags/alpha/simulate').send({samples:100}).expect(422);
    await put('alpha',CONFIG_50_50);
  });

  it('simulates a large sample matching the slot shares',async()=>{
    await put('alpha',CONFIG_DECIMALS);
    const app=createApp();
    const result=await request(app).post('/api/flags/alpha/simulate').send({samples:100000}).expect(200);
    expect(result.body.samples).toBe(100000);
    const counts=result.body.counts;
    expect(counts.control+counts['treatment-a']+counts['treatment-b']).toBe(100000);
    expect(result.body.expectedSlots).toEqual({control:3333,'treatment-a':3333,'treatment-b':3334});
    for(const key of Object.keys(counts)){
      const expected=(result.body.expectedSlots[key]/TOTAL_SLOTS)*100000;
      expect(Math.abs(counts[key]-expected)).toBeLessThanOrEqual(700);
    }
    await request(app).post('/api/flags/alpha/simulate').send({samples:0}).expect(400);
  });

  it('round-trips a config without drift across saves and reloads',async()=>{
    const saved=await put('alpha',CONFIG_DECIMALS);
    expect(saved.body.content).toBe(CONFIG_DECIMALS);
    const app=createApp();
    const loaded=await request(app).get('/api/flags/alpha').expect(200);
    expect(loaded.body.content).toBe(CONFIG_DECIMALS);
    const again=await request(app).put('/api/flags/alpha').send({content:loaded.body.content,revision:loaded.body.revision}).expect(200);
    expect(again.body.content).toBe(CONFIG_DECIMALS);
    expect(again.body.allocation).toEqual(saved.body.allocation);
    const reloaded=await request(app).get('/api/flags/alpha').expect(200);
    expect(reloaded.body.allocation).toEqual(saved.body.allocation);
  });

  it('includes allocation in analyze results for draft content',async()=>{
    const app=createApp();
    const result=await request(app).post('/api/flags/beta/analyze').send({content:CONFIG_DECIMALS}).expect(200);
    expect(result.body.allocation.ranges.map((range:{key:string})=>range.key)).toEqual(['control','treatment-a','treatment-b']);
    const invalid=await request(app).post('/api/flags/beta/analyze').send({content:'{"variants":[{"key":"a","weight":1}]}'}).expect(200);
    expect(invalid.body.allocation).toBeNull();
    expect(invalid.body.diagnostics.length).toBeGreaterThan(0);
  });
});
