import duckdb
D='C:/Users/suanw/projects/hack/ml-lab/data/jocry/'
c=duckdb.connect(); c.sql("SET TimeZone='UTC'"); c.sql("SET threads=4")
def q(s): print(c.sql(s.replace('@',D)).fetchall(), flush=True)
c.sql(f"CREATE TABLE m AS SELECT mint, COUNT(*) n, COUNT(*) FILTER (WHERE seconds_since_launch<=120) n120, MAX(seconds_since_launch) smax, COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 18120 AND 21720) nlast, COUNT(*) FILTER (WHERE seconds_since_launch BETWEEN 3600 AND 21720) n1to6 FROM read_parquet('{D}trades/*.parquet') GROUP BY 1")
q("SELECT COUNT(*), AVG((n120>0)::INT), AVG((smax>3600)::INT), AVG((nlast>0)::INT) FROM m")
q("SELECT COUNT(*), AVG((smax>3600)::INT), AVG((smax>21720)::INT), AVG((nlast>0)::INT), AVG((n1to6>0)::INT) FROM m WHERE n120>0")
q("SELECT COUNT(*), AVG((nlast>0)::INT) FROM m WHERE n120>=10")
q("SELECT COUNT(*), AVG((nlast>0)::INT) FROM m WHERE n120>=30")
q("SELECT quantile_cont(smax,[0.5,0.75,0.9,0.95,0.99]) FROM m WHERE n120>0")
q("SELECT strftime(date_trunc('day', k.detected_at),'%m-%d'), COUNT(*), AVG((nlast>0)::INT), AVG((m.smax>3600)::INT) FROM m JOIN '@tokens.parquet' k USING(mint) WHERE n120>0 GROUP BY 1 ORDER BY 1")
q("SELECT AVG((k.graduated_at IS NOT NULL)::INT) FROM m JOIN '@tokens.parquet' k USING(mint) WHERE n120>0")
