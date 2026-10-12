import duckdb
D='C:/Users/suanw/projects/hack/ml-lab/data/jocry/'
c=duckdb.connect(); c.sql("SET TimeZone='UTC'"); c.sql("SET threads=4")
def q(s): print(c.sql(s.replace('@',D)).fetchall(), flush=True)
c.sql(f"""CREATE TABLE m AS SELECT mint, COUNT(*) FILTER (WHERE seconds_since_launch<=120) n120,
 MAX(seconds_since_launch) smax,
 COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 900 AND 1800) n15_30,
 COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 1800 AND 2700) n30_45,
 COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 2700 AND 3600) n45_60,
 COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 3600 AND 7200) n60_120,
 COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 18120 AND 21720) nlast
 FROM read_parquet('{D}trades/*.parquet') GROUP BY 1""")
q("""SELECT strftime(date_trunc('day', k.detected_at),'%m-%d') d, COUNT(*) n, round(AVG((n15_30>0)::INT),4) a, round(AVG((n30_45>0)::INT),4) b, round(AVG((n45_60>0)::INT),4) c, round(AVG((n60_120>0)::INT),4) e, SUM((nlast>0)::INT) alive6h, round(quantile_cont(smax,0.99)) p99 FROM m JOIN '@tokens.parquet' k USING(mint) WHERE n120>0 GROUP BY 1 ORDER BY 1""")
